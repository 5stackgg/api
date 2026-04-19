CREATE OR REPLACE FUNCTION public.calculate_tournament_trophies(_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    _tournament_name text;
    _tournament_start timestamptz;
    _tournament_type text;
    _final_stage_id uuid;
    _final_stage_type text;
    _winning_team_id uuid;
    _runner_up_team_id uuid;
    _third_team_id uuid;
    _award_third boolean := false;
    _mvp_steam_id bigint;
BEGIN
    DELETE FROM public.tournament_trophies WHERE tournament_id = _tournament_id;

    SELECT t.name, t.start INTO _tournament_name, _tournament_start
    FROM public.tournaments t WHERE t.id = _tournament_id;

    -- First stage type is the organizer-facing label (e.g. "Single Elimination").
    SELECT type INTO _tournament_type
    FROM public.tournament_stages
    WHERE tournament_id = _tournament_id
    ORDER BY "order" ASC
    LIMIT 1;

    -- Placement is decided by the LAST stage. Prior stages are qualifiers;
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

        -- Roster-wide trophy inserts for each placing team.
        IF _winning_team_id IS NOT NULL THEN
            INSERT INTO public.tournament_trophies
                (tournament_id, tournament_team_id, player_steam_id, placement,
                 tournament_name, tournament_start, tournament_type,
                 custom_name, silhouette, image_url)
            SELECT
                _tournament_id, _winning_team_id, roster.player_steam_id, 1,
                _tournament_name, _tournament_start, _tournament_type,
                cfg.custom_name, cfg.silhouette, cfg.image_url
            FROM public.tournament_team_roster roster
            LEFT JOIN public.tournament_trophy_configs cfg
              ON cfg.tournament_id = _tournament_id AND cfg.placement = 1
            WHERE roster.tournament_team_id = _winning_team_id
              AND roster.tournament_id = _tournament_id;
        END IF;

        IF _runner_up_team_id IS NOT NULL THEN
            INSERT INTO public.tournament_trophies
                (tournament_id, tournament_team_id, player_steam_id, placement,
                 tournament_name, tournament_start, tournament_type,
                 custom_name, silhouette, image_url)
            SELECT
                _tournament_id, _runner_up_team_id, roster.player_steam_id, 2,
                _tournament_name, _tournament_start, _tournament_type,
                cfg.custom_name, cfg.silhouette, cfg.image_url
            FROM public.tournament_team_roster roster
            LEFT JOIN public.tournament_trophy_configs cfg
              ON cfg.tournament_id = _tournament_id AND cfg.placement = 2
            WHERE roster.tournament_team_id = _runner_up_team_id
              AND roster.tournament_id = _tournament_id;
        END IF;

        IF _award_third AND _third_team_id IS NOT NULL THEN
            INSERT INTO public.tournament_trophies
                (tournament_id, tournament_team_id, player_steam_id, placement,
                 tournament_name, tournament_start, tournament_type,
                 custom_name, silhouette, image_url)
            SELECT
                _tournament_id, _third_team_id, roster.player_steam_id, 3,
                _tournament_name, _tournament_start, _tournament_type,
                cfg.custom_name, cfg.silhouette, cfg.image_url
            FROM public.tournament_team_roster roster
            LEFT JOIN public.tournament_trophy_configs cfg
              ON cfg.tournament_id = _tournament_id AND cfg.placement = 3
            WHERE roster.tournament_team_id = _third_team_id
              AND roster.tournament_id = _tournament_id;
        END IF;

    ELSE
        -- Round-robin / Swiss finals: no bracket to read, so fall back to
        -- standings — but scoped to the final stage only, not summed across
        -- stages. Tie for 3rd => no bronze, matching the bracket behavior.
        INSERT INTO public.tournament_trophies
            (tournament_id, tournament_team_id, player_steam_id, placement,
             tournament_name, tournament_start, tournament_type,
             custom_name, silhouette, image_url)
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
            _tournament_id,
            r.tournament_team_id,
            roster.player_steam_id,
            r.placement,
            _tournament_name,
            _tournament_start,
            _tournament_type,
            cfg.custom_name,
            cfg.silhouette,
            cfg.image_url
        FROM ranked r
        JOIN tie_counts tc USING (placement)
        JOIN public.tournament_team_roster roster
          ON roster.tournament_team_id = r.tournament_team_id
         AND roster.tournament_id = _tournament_id
        LEFT JOIN public.tournament_trophy_configs cfg
          ON cfg.tournament_id = _tournament_id
         AND cfg.placement = r.placement
        WHERE r.placement <= 3
          AND NOT (r.placement = 3 AND tc.team_count > 1);

        SELECT tournament_team_id INTO _winning_team_id
        FROM public.tournament_trophies
        WHERE tournament_id = _tournament_id AND placement = 1
        LIMIT 1;
    END IF;

    -- MVP: highest avg ELO impact on the WINNING team across all tournament matches.
    IF _winning_team_id IS NOT NULL THEN
        WITH t_matches AS (
            SELECT DISTINCT tb.match_id
            FROM public.tournament_brackets tb
            JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id
            WHERE ts.tournament_id = _tournament_id
              AND tb.match_id IS NOT NULL
        ),
        elo_impact AS (
            SELECT
                pe.steam_id,
                AVG(pe.change)::float AS avg_change,
                SUM(pe.change)::float AS total_change,
                COUNT(*)::int AS matches
            FROM public.player_elo pe
            WHERE pe.match_id IN (SELECT match_id FROM t_matches)
            GROUP BY pe.steam_id
        )
        SELECT ei.steam_id INTO _mvp_steam_id
        FROM elo_impact ei
        JOIN public.tournament_team_roster roster
          ON roster.player_steam_id = ei.steam_id
         AND roster.tournament_id = _tournament_id
         AND roster.tournament_team_id = _winning_team_id
        WHERE ei.matches > 0
        ORDER BY ei.avg_change DESC,
                 ei.total_change DESC,
                 ei.steam_id ASC
        LIMIT 1;

        IF _mvp_steam_id IS NOT NULL THEN
            INSERT INTO public.tournament_trophies
                (tournament_id, tournament_team_id, player_steam_id, placement,
                 tournament_name, tournament_start, tournament_type,
                 custom_name, silhouette, image_url)
            SELECT
                _tournament_id,
                _winning_team_id,
                _mvp_steam_id,
                0,
                _tournament_name,
                _tournament_start,
                _tournament_type,
                cfg.custom_name,
                cfg.silhouette,
                cfg.image_url
            FROM (SELECT 1) dummy
            LEFT JOIN public.tournament_trophy_configs cfg
              ON cfg.tournament_id = _tournament_id
             AND cfg.placement = 0;
        END IF;
    END IF;
END;
$$;
