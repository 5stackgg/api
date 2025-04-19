CREATE OR REPLACE FUNCTION public.get_map_veto_pattern(_match public.matches) RETURNS text[]
    LANGUAGE plpgsql
AS $$
DECLARE
    pool uuid[];
    best_of int;
    pattern TEXT[] := '{}';
    base_pattern TEXT[] := '{}';
    pattern_length INT;
    i INT;
    pool_size INT;
    _type TEXT;
    base_pattern_length INT;
BEGIN
    SELECT mo.best_of INTO best_of
    FROM matches m
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    WHERE m.id = _match.id;

    SELECT array_agg(mp.map_id) INTO pool
    FROM matches m
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    LEFT JOIN _map_pool mp ON mp.map_pool_id = mo.map_pool_id
    WHERE m.id = _match.id;

    pool_size := coalesce(array_length(pool, 1), 0);

    IF best_of = 1 THEN
        base_pattern := ARRAY['Ban'];
    ELSIF pool_size < best_of + 2 THEN
        base_pattern := ARRAY['Ban', 'Pick', 'Pick'];
    ELSE
        base_pattern := ARRAY['Ban', 'Ban', 'Pick', 'Pick'];
    END IF;

    FOR i IN 1..(pool_size - 1) LOOP
        _type := base_pattern[1 + ((i - 1) % array_length(base_pattern, 1))];
        pattern := array_append(pattern, _type);

        IF _type = 'Pick' THEN
            pattern := array_append(pattern, 'Side');
        END IF;
    END LOOP;

    pattern := array_append(pattern, 'Decider');

    RETURN pattern;
END;
$$;
