CREATE OR REPLACE FUNCTION public.update_match_state(_match_map match_maps) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    maps_won INT := 0;
    match_best_of INT;
    map_lineup_1_score INT;
    map_lineup_2_score INT;
    match_lineup_1_id UUID;
    match_lineup_2_id UUID;
    current_match_status TEXT;
    match_winning_lineup_id UUID;
    lineup_1_wins INT := 0;
    lineup_2_wins INT := 0;
    final_advantage INT := 0;
    match_map public.match_maps;
BEGIN
    -- Retrieve match best_of value
    SELECT mo.best_of, lineup_1_id, lineup_2_id
    INTO match_best_of, match_lineup_1_id, match_lineup_2_id
    FROM matches m
    INNER JOIN match_options mo
    ON mo.id = m.match_options_id
    WHERE m.id = _match_map.match_id;

    IF (_match_map.status = 'Finished') THEN
        -- Get current match status and lineups
        SELECT status
        INTO current_match_status
        FROM matches
        WHERE id = _match_map.match_id;

        IF current_match_status IN ('Finished', 'Forfeit', 'Surrendered', 'Canceled', 'Tie') THEN
            RETURN;
        END IF;

        -- Winner-bracket advantage: when this match is the grand final of a
        -- double-elimination stage, the winner-bracket team starts with a map-point
        -- head start. Stays 0 (inert) for every other match.
        -- The grand final is stored as path 'WB' at round wb_rounds+1 with no parent
        -- (generate_double_elimination_bracket); 'GF' is only a round_best_of settings
        -- key, never a stored path. A parentless WB bracket is NOT enough on its
        -- own: a DE stage that passes 2+ teams to a next stage never creates a GF,
        -- leaving each group's WB final parentless too — only the real GF has an
        -- LB feeder as a child. assign_team_to_bracket_slot orders the WB feeder
        -- ahead of the LB feeder, so the winner-bracket team is always slot 1 /
        -- tournament_team_id_1, which schedule_tournament_match maps to lineup_1.
        SELECT COALESCE(ts.final_map_advantage, 0)
        INTO final_advantage
        FROM tournament_brackets tb
        INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        WHERE tb.match_id = _match_map.match_id
          AND ts.type = 'DoubleElimination'
          AND tb.parent_bracket_id IS NULL
          AND COALESCE(tb.path, 'WB') = 'WB'
          AND EXISTS (
              SELECT 1
              FROM tournament_brackets lb
              WHERE lb.parent_bracket_id = tb.id
                AND lb.path = 'LB'
          );

        -- Clamp below the win threshold: at or above it the winner-bracket team
        -- would take the match on the first finished map, even one it lost.
        lineup_1_wins := LEAST(
            COALESCE(final_advantage, 0),
            CEIL(match_best_of / 2.0)::int - 1
        );

        -- Only Finished maps count: an in-progress map's latest round snapshot
        -- would otherwise credit a map win to whoever is momentarily ahead.
        FOR match_map IN
            SELECT *
            FROM match_maps
            WHERE match_id = _match_map.match_id
              AND status = 'Finished'
        LOOP
         	map_lineup_1_score := lineup_1_score(match_map);
            map_lineup_2_score := lineup_2_score(match_map);
            IF map_lineup_1_score = map_lineup_2_score THEN
              CONTINUE;
     	    END IF;
            IF map_lineup_1_score > map_lineup_2_score THEN
                lineup_1_wins := lineup_1_wins + 1;
            ELSE
                lineup_2_wins := lineup_2_wins + 1;
            END IF;
        END LOOP;
        -- Determine the winning lineup
        IF lineup_1_wins > lineup_2_wins THEN
            match_winning_lineup_id := match_lineup_1_id;
        ELSE
            match_winning_lineup_id := match_lineup_2_id;
        END IF;
        IF lineup_1_wins >= CEIL(match_best_of / 2.0) OR lineup_2_wins >= CEIL(match_best_of / 2.0) THEN
            -- Update match status and winning lineup
            UPDATE matches
            SET status = 'Finished', winning_lineup_id = match_winning_lineup_id
            WHERE id = _match_map.match_id;
        END IF;
    END IF;
    RETURN;
END;
$$;
