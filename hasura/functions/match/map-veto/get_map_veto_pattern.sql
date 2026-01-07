CREATE OR REPLACE FUNCTION public.get_map_veto_pattern(_match public.matches) RETURNS text[]
    LANGUAGE plpgsql
AS $$
DECLARE
    pool uuid[];
    best_of int;
    pattern TEXT[] := '{}';
    base_pattern TEXT[] := '{}';
    i INT;
    pool_size INT;
    _type TEXT;
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

    IF(best_of > pool_size) THEN
        RAISE EXCEPTION 'Not enough maps in the pool for the best of %', best_of USING ERRCODE = '22000';
    END IF;

    -- https://github.com/ValveSoftware/counter-strike_rules_and_regs/blob/main/major-supplemental-rulebook.md#map-pick-ban

    IF best_of = 1 THEN
        FOR i IN 1..(pool_size - 1) LOOP
            base_pattern := array_append(base_pattern, 'Ban');
        END LOOP;
        base_pattern := array_append(base_pattern, 'Decider');
    ELSIF pool_size = best_of THEN
         FOR i IN 1..(pool_size - 1) LOOP
            base_pattern := array_append(base_pattern, 'Pick');
        END LOOP;
        base_pattern := array_append(base_pattern, 'Decider');
    ELSIF best_of = 3 THEN
        IF pool_size = 4 THEN
            base_pattern := ARRAY['Pick', 'Pick', 'Pick', 'Decider'];
        ELSIF pool_size = 5 THEN
            base_pattern := ARRAY['Ban', 'Pick', 'Pick', 'Pick', 'Decider'];
        ELSIF pool_size = 6 THEN
            base_pattern := ARRAY['Ban', 'Ban', 'Pick', 'Pick', 'Pick', 'Decider'];
        ELSE
            base_pattern := ARRAY['Ban', 'Ban', 'Pick', 'Pick', 'Ban', 'Ban', 'Decider'];
        END IF;
    ELSIF best_of = 5 THEN
        if pool_size = 6 THEN
            base_pattern := ARRAY['Ban', 'Ban', 'Pick', 'Pick', 'Pick', 'Decider'];
        ELSE
            base_pattern := ARRAY['Ban', 'Ban', 'Pick', 'Pick', 'Pick', 'Pick', 'Decider'];
        END IF;
    END IF;

    IF pool_size > array_length(base_pattern, 1) THEN
        FOR i IN 1..(pool_size - array_length(base_pattern, 1)) LOOP
            base_pattern := array_append(base_pattern, 'Ban');
        END LOOP;
    END IF;
  
    FOR i IN 1..(pool_size - 1) LOOP
        _type := base_pattern[i];
        pattern := array_append(pattern, _type);

        IF _type = 'Pick' THEN
            pattern := array_append(pattern, 'Side');
        END IF;
    END LOOP;

    RETURN pattern;
END;
$$;
