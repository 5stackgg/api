CREATE OR REPLACE FUNCTION public.resolve_tournament_award(_tournament_id uuid, _placement int)
RETURNS uuid
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE(
        (SELECT ta.award_id
           FROM public.tournament_awards ta
          WHERE ta.tournament_id = _tournament_id
            AND ta.placement = _placement),
        (SELECT a.id
           FROM public.awards a
          WHERE a.system_key = CASE _placement
                WHEN 0 THEN 'tournament_mvp'
                WHEN 1 THEN 'tournament_gold'
                WHEN 2 THEN 'tournament_silver'
                WHEN 3 THEN 'tournament_bronze'
          END)
    );
$$;

-- Every tournament lineup seats the whole roster, substitutes included, so a
-- seat is not proof of play; recorded activity is. A match that finished with
-- nothing recorded for the lineup (a result set by hand after a crash, a LAN
-- final) cannot say who played, so everyone seated in it counts. A forfeit is
-- never such a match; one stored before forfeits kept their status reads
-- Finished, and is told apart by the no-shows it records in abandoned_matches.
-- A team left with no one at all, every match a forfeit, keeps every seated
-- player.
CREATE OR REPLACE FUNCTION public.tournament_team_medalists(_tournament_id uuid, _tournament_team_id uuid)
RETURNS TABLE (player_steam_id bigint)
LANGUAGE sql STABLE
AS $$
    WITH seats AS (
        SELECT
            roster.player_steam_id,
            m.id AS match_id,
            m.status,
            public.player_has_match_activity(m.id, roster.player_steam_id) AS played
        FROM public.tournament_team_roster roster
        JOIN public.tournament_stages ts ON ts.tournament_id = roster.tournament_id
        JOIN public.tournament_brackets tb
          ON tb.tournament_stage_id = ts.id
         AND roster.tournament_team_id IN (tb.tournament_team_id_1, tb.tournament_team_id_2)
        JOIN public.matches m ON m.id = tb.match_id
        JOIN public.match_lineup_players mlp
          ON mlp.steam_id = roster.player_steam_id
         AND mlp.match_lineup_id = CASE WHEN tb.tournament_team_id_1 = roster.tournament_team_id
                                        THEN m.lineup_1_id ELSE m.lineup_2_id END
        WHERE roster.tournament_id = _tournament_id
          AND roster.tournament_team_id = _tournament_team_id
    ),
    unrecorded AS (
        SELECT seat.match_id
        FROM seats seat
        WHERE seat.status IN ('Finished', 'Tie', 'Surrendered')
          AND NOT EXISTS (
              SELECT 1 FROM public.abandoned_matches am
              WHERE am.match_id = seat.match_id
          )
        GROUP BY seat.match_id
        HAVING NOT bool_or(seat.played)
    ),
    medalists AS (
        SELECT DISTINCT seat.player_steam_id
        FROM seats seat
        WHERE seat.played
           OR seat.match_id IN (SELECT match_id FROM unrecorded)
    )
    SELECT player_steam_id FROM medalists
    UNION
    SELECT seat.player_steam_id
    FROM seats seat
    WHERE NOT EXISTS (SELECT 1 FROM medalists);
$$;

CREATE OR REPLACE FUNCTION public.calculate_tournament_awards(_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    _awards_enabled boolean;
    _winning_team_id uuid;
    _runner_up_team_id uuid;
    _third_team_id uuid;
    _award_third boolean := false;
    _final_stage_id uuid;
BEGIN
    SELECT awards_enabled INTO _awards_enabled
    FROM public.tournaments WHERE id = _tournament_id;

    -- Always clear prior auto rows so disabling / recalculating lands in a known state.
    -- Hand-granted awards survive; organizers own those explicitly.
    DELETE FROM public.award_recipients
    WHERE tournament_id = _tournament_id AND source = 'tournament';

    IF _awards_enabled IS DISTINCT FROM true THEN
        RETURN;
    END IF;

    -- The placements read the last stage's cached standings, and a bye can
    -- finish the tournament inside update_tournament_bracket before it
    -- refreshes them.
    SELECT id INTO _final_stage_id
    FROM public.tournament_stages
    WHERE tournament_id = _tournament_id
    ORDER BY "order" DESC
    LIMIT 1;

    IF _final_stage_id IS NOT NULL THEN
        PERFORM public.recompute_tournament_stage_results(_final_stage_id);
    END IF;

    SELECT p.tournament_team_id INTO _winning_team_id
    FROM public.tournament_placements(_tournament_id) p
    WHERE p.placement = 1;

    SELECT p.tournament_team_id INTO _runner_up_team_id
    FROM public.tournament_placements(_tournament_id) p
    WHERE p.placement = 2;

    -- No bronze for a shared 3rd: both semifinal losers without a decider.
    SELECT p.tournament_team_id INTO _third_team_id
    FROM public.tournament_placements(_tournament_id) p
    WHERE p.placement = 3
      AND (
          SELECT COUNT(*) FROM public.tournament_placements(_tournament_id) shared
          WHERE shared.placement = 3
      ) = 1;

    _award_third := _third_team_id IS NOT NULL;

    -- Defensive guard for malformed brackets or stale data: a team cannot
    -- receive both a placement medal and bronze in the same calculation.
    IF _third_team_id IS NOT NULL
       AND (_third_team_id = _winning_team_id OR _third_team_id = _runner_up_team_id) THEN
        _third_team_id := NULL;
        _award_third := false;
    END IF;

    -- Uniqueness key includes placement, so the MVP player also keeps their gold row.
    IF _winning_team_id IS NOT NULL THEN
        PERFORM public.apply_tournament_mvp(_tournament_id);
    END IF;

    -- Team-level placement awards. These are only granted when the tournament
    -- entry is backed by a real team (tournament_teams.team_id); ad-hoc
    -- tournament-only teams still only grant player awards.
    IF _winning_team_id IS NOT NULL THEN
        INSERT INTO public.award_recipients
            (award_id, tournament_id, tournament_team_id, team_id, placement, source)
        SELECT
            public.resolve_tournament_award(_tournament_id, 1),
            _tournament_id, tournament_team.id, tournament_team.team_id, 1, 'tournament'
        FROM public.tournament_teams tournament_team
        WHERE tournament_team.id = _winning_team_id
          AND tournament_team.tournament_id = _tournament_id
          AND tournament_team.team_id IS NOT NULL
        ON CONFLICT DO NOTHING;
    END IF;

    IF _runner_up_team_id IS NOT NULL THEN
        INSERT INTO public.award_recipients
            (award_id, tournament_id, tournament_team_id, team_id, placement, source)
        SELECT
            public.resolve_tournament_award(_tournament_id, 2),
            _tournament_id, tournament_team.id, tournament_team.team_id, 2, 'tournament'
        FROM public.tournament_teams tournament_team
        WHERE tournament_team.id = _runner_up_team_id
          AND tournament_team.tournament_id = _tournament_id
          AND tournament_team.team_id IS NOT NULL
        ON CONFLICT DO NOTHING;
    END IF;

    IF _award_third AND _third_team_id IS NOT NULL THEN
        INSERT INTO public.award_recipients
            (award_id, tournament_id, tournament_team_id, team_id, placement, source)
        SELECT
            public.resolve_tournament_award(_tournament_id, 3),
            _tournament_id, tournament_team.id, tournament_team.team_id, 3, 'tournament'
        FROM public.tournament_teams tournament_team
        WHERE tournament_team.id = _third_team_id
          AND tournament_team.tournament_id = _tournament_id
          AND tournament_team.team_id IS NOT NULL
        ON CONFLICT DO NOTHING;
    END IF;

    -- Gold / silver / bronze for the placing teams' rostered players who
    -- played. ON CONFLICT skips any player who already has a matching
    -- hand-granted award at this placement. Leaving the conflict target
    -- unspecified keeps this function tolerant of both the placement-aware
    -- recipient key and the partial MVP index.
    IF _winning_team_id IS NOT NULL THEN
        INSERT INTO public.award_recipients
            (award_id, tournament_id, tournament_team_id, player_steam_id, placement, source)
        SELECT
            public.resolve_tournament_award(_tournament_id, 1),
            _tournament_id, _winning_team_id, medalist.player_steam_id, 1, 'tournament'
        FROM public.tournament_team_medalists(_tournament_id, _winning_team_id) medalist
        ON CONFLICT DO NOTHING;
    END IF;

    IF _runner_up_team_id IS NOT NULL THEN
        INSERT INTO public.award_recipients
            (award_id, tournament_id, tournament_team_id, player_steam_id, placement, source)
        SELECT
            public.resolve_tournament_award(_tournament_id, 2),
            _tournament_id, _runner_up_team_id, medalist.player_steam_id, 2, 'tournament'
        FROM public.tournament_team_medalists(_tournament_id, _runner_up_team_id) medalist
        ON CONFLICT DO NOTHING;
    END IF;

    IF _award_third AND _third_team_id IS NOT NULL THEN
        INSERT INTO public.award_recipients
            (award_id, tournament_id, tournament_team_id, player_steam_id, placement, source)
        SELECT
            public.resolve_tournament_award(_tournament_id, 3),
            _tournament_id, _third_team_id, medalist.player_steam_id, 3, 'tournament'
        FROM public.tournament_team_medalists(_tournament_id, _third_team_id) medalist
        ON CONFLICT DO NOTHING;
    END IF;
END;
$$;
