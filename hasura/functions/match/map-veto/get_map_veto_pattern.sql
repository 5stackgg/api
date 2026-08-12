CREATE OR REPLACE FUNCTION public.get_map_veto_pattern(_match public.matches) RETURNS text[]
    LANGUAGE plpgsql
AS $$
DECLARE
    best_of int;
    pattern TEXT[] := '{}';
    base_pattern TEXT[] := '{}';
    i INT;
    pool_size INT;
    surplus INT;
    _type TEXT;
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

    -- https://github.com/ValveSoftware/counter-strike_rules_and_regs/blob/main/major-supplemental-rulebook.md#map-pick-ban

    IF best_of = 3 AND pool_size >= 4 THEN
        IF pool_size = 4 THEN
            base_pattern := ARRAY['Ban', 'Pick', 'Pick'];
        ELSIF pool_size = 5 THEN
            -- Both bans open the veto, as in the 6- and 7-map patterns below and
            -- in the linked rulebook. Ban/Pick/Pick/Ban let a map be picked
            -- before either team had finished banning, and it was the only BO3
            -- pool that did not lead with two bans -- which is also what the
            -- turn-swap in get_map_veto_picking_lineup_id assumes.
            base_pattern := ARRAY['Ban', 'Ban', 'Pick', 'Pick'];
        ELSIF pool_size = 6 THEN
            base_pattern := ARRAY['Ban', 'Ban', 'Pick', 'Pick', 'Ban'];
        ELSE
            base_pattern := ARRAY['Ban', 'Ban', 'Pick', 'Pick', 'Ban', 'Ban'];
        END IF;
    ELSIF best_of = 5 AND pool_size >= 6 THEN
        IF pool_size = 6 THEN
            base_pattern := ARRAY['Ban', 'Pick', 'Pick', 'Pick', 'Pick'];
        ELSE
            base_pattern := ARRAY['Ban', 'Ban', 'Pick', 'Pick', 'Pick', 'Pick'];
        END IF;
    ELSE
        -- Everything the rulebook doesn't cover (BO1, a pool only big enough to
        -- pick from, any other best of): pick the maps that get played and let
        -- the bans below account for the rest. Without this arm an unsupported
        -- best of returned a pattern of NULLs and the veto could never finish.
        base_pattern := array_fill('Pick'::text, ARRAY[best_of - 1]);
    END IF;

    -- Maps the pattern doesn't account for are banned up front, trimming the
    -- pool to the rulebook shape before the picks. The Decider closes: it is
    -- only ever auto-inserted by create_match_map_from_veto once one map is
    -- left, so any step sitting after it can never be satisfied.
    surplus := pool_size - 1 - coalesce(array_length(base_pattern, 1), 0);
    base_pattern := array_append(
        array_fill('Ban'::text, ARRAY[surplus]) || base_pattern,
        'Decider'
    );

    FOR i IN 1..(pool_size) LOOP
        _type := base_pattern[i];

        pattern := pattern ||
            CASE
                WHEN _type = 'Pick' THEN ARRAY['Pick', 'Side']
                ELSE ARRAY[_type]
            END;
    END LOOP;

    RETURN pattern;
END;
$$;
