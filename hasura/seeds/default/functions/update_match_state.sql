CREATE FUNCTION public.update_match_state() RETURNS trigger
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
    match_map public.match_maps;
BEGIN
    -- Retrieve match best_of value
    SELECT mo.best_of, lineup_1_id, lineup_2_id
    INTO match_best_of, match_lineup_1_id, match_lineup_2_id
    FROM matches m
    INNER JOIN match_options mo
    ON mo.id = m.match_options_id
    WHERE m.id = NEW.match_id;
    IF (NEW.status = 'Finished') THEN
        -- Get current match status and lineups
        SELECT status
        INTO current_match_status
        FROM matches
        WHERE id = NEW.match_id;
        IF current_match_status = 'Forfeit' THEN
            RETURN NEW;
        END IF;
        -- Loop through match maps and calculate wins
        FOR match_map IN
            SELECT *
            FROM match_maps
            WHERE match_id = NEW.match_id
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
        IF lineup_1_wins = CEIL(match_best_of / 2.0) OR lineup_2_wins = CEIL(match_best_of / 2.0) THEN
            -- Update match status and winning lineup
            UPDATE matches
            SET status = 'Finished', winning_lineup_id = match_winning_lineup_id
            WHERE id = NEW.match_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;