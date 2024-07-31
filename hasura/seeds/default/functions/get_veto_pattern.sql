CREATE OR REPLACE FUNCTION public.get_veto_pattern(_match public.matches) RETURNS text[]
    LANGUAGE plpgsql
    AS $$
DECLARE
    pool uuid[];
	best_of int;
    pattern TEXT[] := '{}';
    base_pattern TEXT[] := ARRAY['Ban', 'Ban', 'Pick', 'Pick'];
    picks_count INT;
    picks_left INT;
    pattern_length INT;
    i INT;
BEGIN
	SELECT mo.best_of INTO best_of
        FROM matches m
        INNER JOIN match_options mo on mo.id = m.match_options_id
        where m.id = _match.id;
    SELECT array_agg(mp.map_id) INTO pool
        FROM matches m
        INNER JOIN match_options mo on mo.id = m.match_options_id
        LEFT JOIN _map_pool mp ON mp.map_pool_id = mo.map_pool_id
        LEFT JOIN match_veto_picks mvp ON mvp.match_id = _match.id AND mvp.map_id = mp.map_id
        WHERE m.id = _match.id;
    -- Loop to build the pattern array
    WHILE array_length(pattern, 1) IS DISTINCT FROM coalesce(array_length(pool, 1), 0) - 1 LOOP
        -- Count the number of 'Pick' elements in the pattern array
        picks_count := 0;
        IF array_length(pattern, 1) IS NOT NULL THEN
            FOR i IN 1..array_length(pattern, 1) LOOP
                IF pattern[i] = 'Pick' THEN
                    picks_count := picks_count + 1;
                END IF;
            END LOOP;
        END IF;
        -- Logic for adding elements to the pattern array
        IF picks_count = best_of - 1 THEN
            pattern := array_append(pattern, 'Ban');
            CONTINUE;
        END IF;
        picks_left := coalesce(array_length(pool, 1), 0) - coalesce(array_length(pattern, 1), 0) - 1;
        IF picks_left < picks_count + 2 THEN
            pattern := array_append(pattern, 'Pick');
            CONTINUE;
        END IF;
        pattern := pattern || base_pattern[1:picks_left];
    END LOOP;
    -- Insert 'Side' elements after each 'Pick' in the pattern array
    pattern_length := coalesce(array_length(pattern, 1), 0);
    i := 1;
    WHILE i <= pattern_length LOOP
        IF pattern[i] = 'Pick' THEN
            pattern := array_cat(array_cat(pattern[1:i], ARRAY['Side']), pattern[i+1:pattern_length]);
            pattern_length := pattern_length + 1;
            i := i + 1; -- Skip the next element as it is newly added
        END IF;
        i := i + 1;
    END LOOP;
    RETURN pattern;
END;
$$;