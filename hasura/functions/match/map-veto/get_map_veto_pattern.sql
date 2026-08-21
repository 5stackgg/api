CREATE OR REPLACE FUNCTION public.get_map_veto_pattern(_match public.matches) RETURNS text[]
    LANGUAGE plpgsql
AS $$
DECLARE
    best_of int;
    pool_size int;
    pattern TEXT[] := '{}';
    -- https://docs.5stack.gg/features/map-veto
    unit TEXT[] := ARRAY['Ban', 'Ban', 'Pick', 'Pick'];
    unit_index int := 0;
    picks_needed int;
    picks_made int := 0;
    steps_left int;
    _type TEXT;
    i INT;
BEGIN
    SELECT mo.best_of INTO best_of
    FROM matches m
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    WHERE m.id = _match.id;

    -- count() over the LEFT JOIN: an empty pool yields a row with a NULL
    -- map_id, which array_agg would report as a pool of one.
    SELECT count(mp.map_id) INTO pool_size
    FROM matches m
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    LEFT JOIN _map_pool mp ON mp.map_pool_id = mo.map_pool_id
    WHERE m.id = _match.id;

    IF(best_of > pool_size) THEN
        RAISE EXCEPTION 'Not enough maps in the pool for the best of %', best_of USING ERRCODE = '22000';
    END IF;

    picks_needed := best_of - 1;

    -- The veto runs for pool - 1 steps; the one map nobody bans or picks is the
    -- Decider, which always closes (it is auto-inserted once a single map is
    -- left, so any step sitting after it could never be satisfied).
    FOR i IN 1..(pool_size - 1) LOOP
        -- Steps remaining, this one included.
        steps_left := pool_size - i;

        IF picks_made = picks_needed THEN
            -- Enough maps are picked to fill the series: ban out the rest. This
            -- is where a pool larger than the pattern spends its extra bans,
            -- after the picks and before the Decider.
            _type := 'Ban';
        ELSIF steps_left = picks_needed - picks_made THEN
            -- Any more banning would leave too few maps to pick from.
            _type := 'Pick';
        ELSE
            _type := unit[unit_index % 4 + 1];
            unit_index := unit_index + 1;
        END IF;

        IF _type = 'Pick' THEN
            picks_made := picks_made + 1;
            -- Every Pick is answered by a Side.
            pattern := pattern || ARRAY['Pick', 'Side'];
        ELSE
            pattern := pattern || ARRAY['Ban'];
        END IF;
    END LOOP;

    RETURN pattern || ARRAY['Decider'];
END;
$$;
