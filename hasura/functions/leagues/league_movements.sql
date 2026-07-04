-- Promotion/relegation: computed from regular-season (RoundRobin stage)
-- standings at season finish; admins review, optionally override the
-- destination, and approve. Approved movements drive next-season auto-slotting.

CREATE OR REPLACE FUNCTION public.compute_league_season_movements(_league_season_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    season public.league_seasons;
BEGIN
    SELECT * INTO season FROM public.league_seasons WHERE id = _league_season_id;

    -- Recompute is idempotent; approved rows are left untouched.
    DELETE FROM public.league_team_movements
    WHERE league_season_id = _league_season_id
      AND approved_at IS NULL;

    -- ESEA bands (per division, by effective_rank r, division size N):
    --   r <= dp                               -> DirectPromote (needs a division above)
    --   dp < r <= dp+ru                       -> RelegationUp (playoff; needs above)
    --   r > N - dr                            -> DirectRelegate (needs below)
    --   N - dr - rd < r <= N - dr             -> RelegationDown (playoff; needs below)
    --   otherwise                             -> Hold
    -- Top division suppresses promote/relegation-up (no division above); the
    -- bottom division suppresses relegate/relegation-down (no division below).
    -- RelegationUp/RelegationDown leave computed_to_division_id NULL — resolved
    -- by the relegation playoff.
    INSERT INTO public.league_team_movements (
        league_season_id, league_team_id, from_division_id,
        computed_to_division_id, type, final_rank
    )
    SELECT
        _league_season_id,
        s.league_team_id,
        s.league_division_id,
        -- The `<= N - dr - rd` guard on the promote bands keeps them from
        -- overlapping the relegate bands in a small or withdrawal-shrunk
        -- division (where dp+ru+rd+dr > N); it is a no-op for a healthy field.
        CASE
            WHEN s.withdrawn THEN NULL
            WHEN up.id IS NOT NULL
                 AND s.effective_rank <= season.direct_promote_count
                 AND s.effective_rank <= s.division_team_count - season.direct_relegate_count - season.relegation_down_count THEN up.id
            WHEN down.id IS NOT NULL AND s.effective_rank > s.division_team_count - season.direct_relegate_count THEN down.id
            WHEN up.id IS NOT NULL
                 AND s.effective_rank <= season.direct_promote_count + season.relegation_up_count
                 AND s.effective_rank <= s.division_team_count - season.direct_relegate_count - season.relegation_down_count THEN NULL
            WHEN down.id IS NOT NULL
                 AND s.effective_rank > s.division_team_count - season.direct_relegate_count - season.relegation_down_count THEN NULL
            ELSE s.league_division_id
        END,
        CASE
            WHEN s.withdrawn THEN 'Remove'
            WHEN up.id IS NOT NULL
                 AND s.effective_rank <= season.direct_promote_count
                 AND s.effective_rank <= s.division_team_count - season.direct_relegate_count - season.relegation_down_count THEN 'DirectPromote'
            WHEN down.id IS NOT NULL AND s.effective_rank > s.division_team_count - season.direct_relegate_count THEN 'DirectRelegate'
            WHEN up.id IS NOT NULL
                 AND s.effective_rank <= season.direct_promote_count + season.relegation_up_count
                 AND s.effective_rank <= s.division_team_count - season.direct_relegate_count - season.relegation_down_count THEN 'RelegationUp'
            WHEN down.id IS NOT NULL
                 AND s.effective_rank > s.division_team_count - season.direct_relegate_count - season.relegation_down_count THEN 'RelegationDown'
            ELSE 'Hold'
        END,
        s.effective_rank
    FROM (
        -- Withdrawn teams are removed, not ranked: surviving teams are
        -- re-ranked without them so promotion/relegation thresholds count
        -- real teams only (a mid-table withdrawal must not push an extra
        -- survivor into the relegation zone).
        SELECT vs.*,
               (lts.status = 'Withdrawn') AS withdrawn,
               CASE WHEN lts.status != 'Withdrawn' THEN
                   ROW_NUMBER() OVER (
                       PARTITION BY vs.league_season_division_id,
                                    (lts.status = 'Withdrawn')
                       ORDER BY vs.rank
                   )
               END AS effective_rank,
               COUNT(*) FILTER (WHERE lts.status != 'Withdrawn')
                   OVER (PARTITION BY vs.league_season_division_id) AS division_team_count
        FROM public.v_league_division_standings vs
        JOIN public.league_team_seasons lts ON lts.id = vs.league_team_season_id
        WHERE vs.league_season_id = _league_season_id
    ) s
    JOIN public.league_divisions ld ON ld.id = s.league_division_id
    LEFT JOIN public.league_divisions up
      ON up.tier = ld.tier - 1 AND up.active = true
    LEFT JOIN public.league_divisions down
      ON down.tier = ld.tier + 1 AND down.active = true
    ON CONFLICT (league_season_id, league_team_id) DO NOTHING;
END;
$$;

-- Approve every movement of a season in one call (admin convenience; exposed
-- as a Hasura mutation for administrators). Individual overrides happen via
-- normal updates of final_to_division_id before approval.
CREATE OR REPLACE FUNCTION public.approve_league_season_movements(
    _league_season_id uuid,
    hasura_session json
)
RETURNS SETOF public.league_team_movements
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT public.is_league_admin_for_session(hasura_session) THEN
        RAISE EXCEPTION 'Must be a league admin' USING ERRCODE = '22000';
    END IF;

    UPDATE public.league_team_movements
    SET approved_at = NOW(),
        approved_by_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
    WHERE league_season_id = _league_season_id
      AND approved_at IS NULL;

    RETURN QUERY
    SELECT * FROM public.league_team_movements
    WHERE league_season_id = _league_season_id;
END;
$$;
