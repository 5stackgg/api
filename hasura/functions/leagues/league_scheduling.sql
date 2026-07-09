-- League scheduling: week resolution for a bracket, the weekly default-time
-- fallback, and admin forfeit adjudication.

-- The match week a league regular-season bracket belongs to (bracket.round =
-- week_number). Returns NULL for non-league or playoff brackets.
CREATE OR REPLACE FUNCTION public.league_bracket_match_week(_tournament_bracket_id uuid)
RETURNS public.league_match_weeks
LANGUAGE sql
STABLE
AS $$
    SELECT lmw.*
    FROM public.tournament_brackets tb
    JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id AND ts."order" = 1
    JOIN public.league_season_divisions lsd ON lsd.tournament_id = ts.tournament_id
    JOIN public.league_match_weeks lmw
      ON lmw.league_season_id = lsd.league_season_id
     AND lmw.week_number = tb.round
    WHERE tb.id = _tournament_bracket_id;
$$;

-- Stamp the week's default time on every league regular-season matchup the two
-- teams never agreed on, once the default is near (2h lead). The existing
-- CheckForScheduledTournamentBrackets cron then materializes the matches.
-- Also expires stale pending proposals. Returns the number of brackets stamped.
CREATE OR REPLACE FUNCTION public.apply_league_default_schedules()
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
    _stamped int;
BEGIN
    WITH due AS (
        SELECT tb.id, lmw.default_match_at
        FROM public.tournament_brackets tb
        JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id AND ts."order" = 1
        JOIN public.league_season_divisions lsd ON lsd.tournament_id = ts.tournament_id
        JOIN public.league_seasons ls ON ls.id = lsd.league_season_id AND ls.status = 'Live'
        JOIN public.league_match_weeks lmw
          ON lmw.league_season_id = ls.id
         AND lmw.week_number = tb.round
        WHERE tb.match_id IS NULL
          AND tb.finished = false
          AND tb.scheduled_at IS NULL
          AND tb.tournament_team_id_1 IS NOT NULL
          AND tb.tournament_team_id_2 IS NOT NULL
          -- Stages converged onto per-stage windows are handled by
          -- apply_tournament_default_schedules; this legacy path (round=week)
          -- only covers seasons without windows and mis-maps when
          -- games_per_week > 1.
          AND NOT EXISTS (
              SELECT 1 FROM public.tournament_stage_windows tsw
              WHERE tsw.tournament_stage_id = ts.id
          )
          -- 48h catch-up grace after an outage; anything older is left for
          -- admin adjudication rather than back-stamped into the past.
          AND lmw.default_match_at BETWEEN NOW() - INTERVAL '48 hours'
                                       AND NOW() + INTERVAL '2 hours'
    )
    UPDATE public.tournament_brackets tb
    SET scheduled_at = due.default_match_at
    FROM due
    WHERE tb.id = due.id;

    GET DIAGNOSTICS _stamped = ROW_COUNT;

    -- Proposals expire when their time passes or the matchup is settled
    -- (finished, or its match progressed beyond the reschedulable states).
    PERFORM set_config('fivestack.proposal_system_write', 'true', true);
    UPDATE public.league_scheduling_proposals lsp
    SET status = 'Expired'
    WHERE lsp.status = 'Pending'
      AND (
        lsp.proposed_time < NOW()
        OR EXISTS (
            SELECT 1 FROM public.tournament_brackets tb
            LEFT JOIN public.matches m ON m.id = tb.match_id
            WHERE tb.id = lsp.tournament_bracket_id
              AND (
                tb.finished = true
                OR (m.id IS NOT NULL AND m.status NOT IN ('Scheduled', 'WaitingForCheckIn'))
              )
        )
      );
    PERFORM set_config('fivestack.proposal_system_write', 'false', true);

    RETURN _stamped;
END;
$$;

-- Admin adjudication of a no-show/unplayed league matchup: materializes the
-- match if needed and awards a forfeit win. Exposed as a Hasura mutation
-- (platform admins and league admins).
DROP FUNCTION IF EXISTS public.league_award_forfeit(uuid, uuid);
CREATE OR REPLACE FUNCTION public.league_award_forfeit(
    _tournament_bracket_id uuid,
    _winning_tournament_team_id uuid,
    hasura_session json
)
RETURNS SETOF public.matches
LANGUAGE plpgsql
AS $$
DECLARE
    bracket public.tournament_brackets;
    _match_id uuid;
    _winning_lineup_id uuid;
BEGIN
    SELECT * INTO bracket FROM public.tournament_brackets WHERE id = _tournament_bracket_id;

    IF bracket IS NULL THEN
        RAISE EXCEPTION 'Bracket not found' USING ERRCODE = '22000';
    END IF;

    IF NOT public.is_league_admin_for_session(hasura_session) THEN
        RAISE EXCEPTION 'Must be a league admin' USING ERRCODE = '22000';
    END IF;

    IF _winning_tournament_team_id NOT IN (bracket.tournament_team_id_1, bracket.tournament_team_id_2) THEN
        RAISE EXCEPTION 'Winning team is not part of this matchup' USING ERRCODE = '22000';
    END IF;

    IF bracket.match_id IS NULL THEN
        -- Admin-mode materialization requires a schedule on the bracket.
        IF bracket.scheduled_at IS NULL THEN
            UPDATE public.tournament_brackets
            SET scheduled_at = NOW()
            WHERE id = bracket.id
            RETURNING * INTO bracket;
        END IF;

        _match_id := public.schedule_tournament_match(bracket);

        IF _match_id IS NULL THEN
            RAISE EXCEPTION 'Could not materialize a match for this bracket' USING ERRCODE = '22000';
        END IF;
    ELSE
        _match_id := bracket.match_id;
    END IF;

    -- Lineup 1 always corresponds to tournament_team_id_1 (see schedule_tournament_match).
    SELECT CASE
        WHEN bracket.tournament_team_id_1 = _winning_tournament_team_id THEN m.lineup_1_id
        ELSE m.lineup_2_id
    END INTO _winning_lineup_id
    FROM public.matches m
    WHERE m.id = _match_id;

    UPDATE public.matches
    SET status = 'Forfeit',
        winning_lineup_id = _winning_lineup_id
    WHERE id = _match_id;

    RETURN QUERY SELECT * FROM public.matches WHERE id = _match_id;
END;
$$;
