CREATE OR REPLACE FUNCTION public.calculate_tournament_trophies(_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    _trophies_enabled boolean;
    _final_stage_id uuid;
    _final_stage_type text;
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
    SELECT id, type
      INTO _final_stage_id, _final_stage_type
    FROM public.tournament_stages
    WHERE tournament_id = _tournament_id
    ORDER BY "order" DESC
    LIMIT 1;

    IF _final_stage_id IS NULL THEN
        RETURN;
    END IF;

    IF _final_stage_type IN ('SingleElimination', 'DoubleElimination') THEN
        -- Final bracket: terminal WB match. In single-elim with a 3rd place
        -- match the final is still match_number=1 at the highest round; the
        -- bronze match sits at match_number=2 in that same round.
        -- In double-elim the grand final is WB at round = wb_rounds + 1.
        WITH final_match AS (
            SELECT
                tb.tournament_team_id_1,
                tb.tournament_team_id_2,
                m.winning_lineup_id,
                m.lineup_1_id,
                m.lineup_2_id
            FROM public.tournament_brackets tb
            LEFT JOIN public.matches m ON m.id = tb.match_id
            WHERE tb.tournament_stage_id = _final_stage_id
              AND tb.path = 'WB'
              AND tb.match_number = 1
            ORDER BY tb.round DESC
            LIMIT 1
        )
        SELECT
            CASE
                WHEN fm.winning_lineup_id = fm.lineup_1_id THEN fm.tournament_team_id_1
                WHEN fm.winning_lineup_id = fm.lineup_2_id THEN fm.tournament_team_id_2
            END,
            CASE
                WHEN fm.winning_lineup_id = fm.lineup_1_id THEN fm.tournament_team_id_2
                WHEN fm.winning_lineup_id = fm.lineup_2_id THEN fm.tournament_team_id_1
            END
          INTO _winning_team_id, _runner_up_team_id
        FROM final_match fm;

        IF _final_stage_type = 'SingleElimination' THEN
            -- Bronze match (optional): same round as final, match_number = 2.
            WITH third_match AS (
                SELECT
                    tb.tournament_team_id_1,
                    tb.tournament_team_id_2,
                    m.winning_lineup_id,
                    m.lineup_1_id,
                    m.lineup_2_id
                FROM public.tournament_brackets tb
                LEFT JOIN public.matches m ON m.id = tb.match_id
                WHERE tb.tournament_stage_id = _final_stage_id
                  AND tb.path = 'WB'
                  AND tb.match_number = 2
                ORDER BY tb.round DESC
                LIMIT 1
            )
            SELECT
                CASE
                    WHEN tm.winning_lineup_id = tm.lineup_1_id THEN tm.tournament_team_id_1
                    WHEN tm.winning_lineup_id = tm.lineup_2_id THEN tm.tournament_team_id_2
                END
              INTO _third_team_id
            FROM third_match tm;

            -- Without a 3rd place match, both semifinal losers tie => no bronze.
            _award_third := _third_team_id IS NOT NULL;
        ELSE
            -- Double-elim: loser of the LB final takes 3rd.
            WITH lb_final AS (
                SELECT
                    tb.tournament_team_id_1,
                    tb.tournament_team_id_2,
                    m.winning_lineup_id,
                    m.lineup_1_id,
                    m.lineup_2_id
                FROM public.tournament_brackets tb
                LEFT JOIN public.matches m ON m.id = tb.match_id
                WHERE tb.tournament_stage_id = _final_stage_id
                  AND tb.path = 'LB'
                ORDER BY tb.round DESC, tb.match_number ASC
                LIMIT 1
            )
            SELECT
                CASE
                    WHEN lf.winning_lineup_id = lf.lineup_1_id THEN lf.tournament_team_id_2
                    WHEN lf.winning_lineup_id = lf.lineup_2_id THEN lf.tournament_team_id_1
                END
              INTO _third_team_id
            FROM lb_final lf;

            _award_third := _third_team_id IS NOT NULL;
        END IF;
    ELSE
        -- Round-robin / Swiss finals: no bracket to read, so fall back to
        -- standings scoped to the final stage only. Gold/silver pick the
        -- first team at each rank (ties still award all tied teams below);
        -- 3rd place only awards when a single team holds it.
        WITH ranked AS (
            SELECT
                r.tournament_team_id,
                RANK() OVER (
                    ORDER BY r.wins DESC,
                             r.head_to_head_match_wins DESC,
                             r.head_to_head_rounds_won DESC,
                             CASE WHEN r.maps_lost > 0
                                  THEN r.maps_won::float / r.maps_lost::float
                                  ELSE r.maps_won::float END DESC,
                             CASE WHEN r.rounds_lost > 0
                                  THEN r.rounds_won::float / r.rounds_lost::float
                                  ELSE r.rounds_won::float END DESC,
                             r.team_kdr DESC
                ) AS placement
            FROM public.v_team_stage_results r
            WHERE r.tournament_stage_id = _final_stage_id
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

    -- Roster-wide gold / silver / bronze. ON CONFLICT skips any player who
    -- already has a matching manual award at this placement.
    IF _winning_team_id IS NOT NULL THEN
        INSERT INTO public.tournament_trophies
            (tournament_id, tournament_team_id, player_steam_id, placement)
        SELECT
            _tournament_id, _winning_team_id, roster.player_steam_id, 1
        FROM public.tournament_team_roster roster
        WHERE roster.tournament_team_id = _winning_team_id
          AND roster.tournament_id = _tournament_id
        ON CONFLICT (tournament_id, tournament_team_id, player_steam_id, placement) DO NOTHING;
    END IF;

    IF _runner_up_team_id IS NOT NULL THEN
        INSERT INTO public.tournament_trophies
            (tournament_id, tournament_team_id, player_steam_id, placement)
        SELECT
            _tournament_id, _runner_up_team_id, roster.player_steam_id, 2
        FROM public.tournament_team_roster roster
        WHERE roster.tournament_team_id = _runner_up_team_id
          AND roster.tournament_id = _tournament_id
        ON CONFLICT (tournament_id, tournament_team_id, player_steam_id, placement) DO NOTHING;
    END IF;

    IF _award_third AND _third_team_id IS NOT NULL THEN
        INSERT INTO public.tournament_trophies
            (tournament_id, tournament_team_id, player_steam_id, placement)
        SELECT
            _tournament_id, _third_team_id, roster.player_steam_id, 3
        FROM public.tournament_team_roster roster
        WHERE roster.tournament_team_id = _third_team_id
          AND roster.tournament_id = _tournament_id
        ON CONFLICT (tournament_id, tournament_team_id, player_steam_id, placement) DO NOTHING;
    END IF;
END;
$$;
