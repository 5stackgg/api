CREATE OR REPLACE FUNCTION public.calculate_tournament_trophies(_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    _trophies_enabled boolean;
    _final_stage_id uuid;
    _winning_team_id uuid;
    _runner_up_team_id uuid;
    _third_team_id uuid;
    _award_third boolean := false;
    _mvp_steam_id bigint;
BEGIN
    SELECT trophies_enabled INTO _trophies_enabled
    FROM public.tournaments WHERE id = _tournament_id;

    -- Always clear prior auto rows so disabling / recalculating lands in a known state.
    -- Manual awards survive; organizers own those explicitly.
    DELETE FROM public.tournament_trophies
    WHERE tournament_id = _tournament_id AND manual = false;

    IF _trophies_enabled IS DISTINCT FROM true THEN
        RETURN;
    END IF;

    -- Placement is decided by the LAST stage. Earlier stages are qualifiers;
    -- their standings don't reflect the tournament result (a team can go
    -- undefeated in Swiss yet lose the playoff final).
    SELECT id
      INTO _final_stage_id
    FROM public.tournament_stages
    WHERE tournament_id = _tournament_id
    ORDER BY "order" DESC
    LIMIT 1;

    IF _final_stage_id IS NULL THEN
        RETURN;
    END IF;

    -- Placement comes from v_team_stage_results, which is the single source of
    -- truth for tournament ordering (DE uses elimination round, RR/Swiss/SE
    -- use wins-based tiebreakers). The view's `placement` column shares ranks
    -- on ties, which lets us suppress the bronze when 3rd is contested
    -- (e.g. SingleElim with no third_place_match → both SF losers tied).
    WITH ranked AS (
        SELECT tournament_team_id, placement
        FROM public.v_team_stage_results
        WHERE tournament_stage_id = _final_stage_id
    ),
    tie_counts AS (
        SELECT placement, COUNT(*) AS team_count
        FROM ranked GROUP BY placement
    )
    SELECT
        MIN(CASE WHEN r.placement = 1 THEN r.tournament_team_id END),
        MIN(CASE WHEN r.placement = 2 THEN r.tournament_team_id END),
        MIN(CASE WHEN r.placement = 3 AND tc.team_count = 1 THEN r.tournament_team_id END)
      INTO _winning_team_id, _runner_up_team_id, _third_team_id
    FROM ranked r
    JOIN tie_counts tc USING (placement);

    _award_third := _third_team_id IS NOT NULL;

    -- Defensive guard for malformed brackets or stale data: a team cannot
    -- receive both a placement medal and bronze in the same calculation.
    IF _third_team_id IS NOT NULL
       AND (_third_team_id = _winning_team_id OR _third_team_id = _runner_up_team_id) THEN
        _third_team_id := NULL;
        _award_third := false;
    END IF;

    -- MVP: highest avg in-match impact on the WINNING team across all tournament matches.
    -- Impact is a level 0.8-1.2 metric (KDA-vs-team + damage share), so MVP reflects
    -- match performance rather than ELO swings, which favor low-rated upsetters.
    -- Uniqueness key includes placement, so the MVP player also keeps their gold row.
    IF _winning_team_id IS NOT NULL THEN
        WITH t_matches AS (
            SELECT DISTINCT tb.match_id
            FROM public.tournament_brackets tb
            JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id
            WHERE ts.tournament_id = _tournament_id
              AND tb.match_id IS NOT NULL
        ),
        player_impact AS (
            SELECT
                pe.steam_id,
                AVG(COALESCE(pe.impact, 1.0))::float AS avg_impact,
                SUM(COALESCE(pe.impact, 1.0))::float AS total_impact,
                COUNT(*)::int AS matches
            FROM public.player_elo pe
            WHERE pe.match_id IN (SELECT match_id FROM t_matches)
            GROUP BY pe.steam_id
        )
        SELECT pi.steam_id INTO _mvp_steam_id
        FROM player_impact pi
        JOIN public.tournament_team_roster roster
          ON roster.player_steam_id = pi.steam_id
         AND roster.tournament_id = _tournament_id
         AND roster.tournament_team_id = _winning_team_id
        WHERE pi.matches > 0
        ORDER BY pi.avg_impact DESC,
                 pi.total_impact DESC,
                 pi.steam_id ASC
        LIMIT 1;

        IF _mvp_steam_id IS NOT NULL THEN
            INSERT INTO public.tournament_trophies
                (tournament_id, tournament_team_id, player_steam_id, placement)
            VALUES
                (_tournament_id, _winning_team_id, _mvp_steam_id, 0)
            ON CONFLICT DO NOTHING;
        END IF;
    END IF;

    -- Team-level placement trophies. These are only awarded when the tournament
    -- entry is backed by a real team (tournament_teams.team_id); ad-hoc
    -- tournament-only teams still only award player trophies.
    IF _winning_team_id IS NOT NULL THEN
        INSERT INTO public.tournament_trophies
            (tournament_id, tournament_team_id, team_id, placement)
        SELECT
            _tournament_id, tournament_team.id, tournament_team.team_id, 1
        FROM public.tournament_teams tournament_team
        WHERE tournament_team.id = _winning_team_id
          AND tournament_team.tournament_id = _tournament_id
          AND tournament_team.team_id IS NOT NULL
        ON CONFLICT DO NOTHING;
    END IF;

    IF _runner_up_team_id IS NOT NULL THEN
        INSERT INTO public.tournament_trophies
            (tournament_id, tournament_team_id, team_id, placement)
        SELECT
            _tournament_id, tournament_team.id, tournament_team.team_id, 2
        FROM public.tournament_teams tournament_team
        WHERE tournament_team.id = _runner_up_team_id
          AND tournament_team.tournament_id = _tournament_id
          AND tournament_team.team_id IS NOT NULL
        ON CONFLICT DO NOTHING;
    END IF;

    IF _award_third AND _third_team_id IS NOT NULL THEN
        INSERT INTO public.tournament_trophies
            (tournament_id, tournament_team_id, team_id, placement)
        SELECT
            _tournament_id, tournament_team.id, tournament_team.team_id, 3
        FROM public.tournament_teams tournament_team
        WHERE tournament_team.id = _third_team_id
          AND tournament_team.tournament_id = _tournament_id
          AND tournament_team.team_id IS NOT NULL
        ON CONFLICT DO NOTHING;
    END IF;

    -- Roster-wide gold / silver / bronze. ON CONFLICT skips any player who
    -- already has a matching manual award at this placement. Leaving the
    -- conflict target unspecified keeps this function tolerant of both the
    -- placement-aware trophy key and the partial MVP index.
    IF _winning_team_id IS NOT NULL THEN
        INSERT INTO public.tournament_trophies
            (tournament_id, tournament_team_id, player_steam_id, placement)
        SELECT
            _tournament_id, _winning_team_id, roster.player_steam_id, 1
        FROM public.tournament_team_roster roster
        WHERE roster.tournament_team_id = _winning_team_id
          AND roster.tournament_id = _tournament_id
        ON CONFLICT DO NOTHING;
    END IF;

    IF _runner_up_team_id IS NOT NULL THEN
        INSERT INTO public.tournament_trophies
            (tournament_id, tournament_team_id, player_steam_id, placement)
        SELECT
            _tournament_id, _runner_up_team_id, roster.player_steam_id, 2
        FROM public.tournament_team_roster roster
        WHERE roster.tournament_team_id = _runner_up_team_id
          AND roster.tournament_id = _tournament_id
        ON CONFLICT DO NOTHING;
    END IF;

    IF _award_third AND _third_team_id IS NOT NULL THEN
        INSERT INTO public.tournament_trophies
            (tournament_id, tournament_team_id, player_steam_id, placement)
        SELECT
            _tournament_id, _third_team_id, roster.player_steam_id, 3
        FROM public.tournament_team_roster roster
        WHERE roster.tournament_team_id = _third_team_id
          AND roster.tournament_id = _tournament_id
        ON CONFLICT DO NOTHING;
    END IF;
END;
$$;
