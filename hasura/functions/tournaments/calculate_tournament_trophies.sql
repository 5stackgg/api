CREATE OR REPLACE FUNCTION public.calculate_tournament_trophies(_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    _tournament_name text;
    _tournament_start timestamptz;
    _tournament_type text;
    _winning_team_id uuid;
    _mvp_steam_id bigint;
BEGIN
    DELETE FROM public.tournament_trophies WHERE tournament_id = _tournament_id;

    SELECT t.name, t.start INTO _tournament_name, _tournament_start
    FROM public.tournaments t WHERE t.id = _tournament_id;

    SELECT type INTO _tournament_type
    FROM public.tournament_stages
    WHERE tournament_id = _tournament_id
    ORDER BY "order" ASC
    LIMIT 1;

    -- 1st / 2nd / 3rd placements. Tie for 3rd => no bronze.
    -- Copy any organizer-set visual config (custom_name/silhouette/image_url)
    -- onto each trophy row so profile views render without joining configs.
    INSERT INTO public.tournament_trophies
        (tournament_id, tournament_team_id, player_steam_id, placement,
         tournament_name, tournament_start, tournament_type,
         custom_name, silhouette, image_url)
    WITH ranked AS (
        SELECT
            tournament_team_id,
            RANK() OVER (
                ORDER BY wins DESC,
                         head_to_head_match_wins DESC,
                         head_to_head_rounds_won DESC,
                         CASE WHEN maps_lost > 0
                              THEN maps_won::float / maps_lost::float
                              ELSE maps_won::float END DESC,
                         CASE WHEN rounds_lost > 0
                              THEN rounds_won::float / rounds_lost::float
                              ELSE rounds_won::float END DESC,
                         team_kdr DESC
            ) AS placement
        FROM public.v_team_tournament_results
        WHERE tournament_id = _tournament_id
    ),
    tie_counts AS (
        SELECT placement, COUNT(*) AS team_count
        FROM ranked
        GROUP BY placement
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

    -- MVP: highest avg ELO impact on the WINNING team across all tournament matches.
    SELECT tournament_team_id INTO _winning_team_id
    FROM public.tournament_trophies
    WHERE tournament_id = _tournament_id AND placement = 1
    LIMIT 1;

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
