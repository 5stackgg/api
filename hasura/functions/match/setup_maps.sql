CREATE OR REPLACE FUNCTION public.setup_match_maps(_match_id UUID, _match_options_id UUID) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    _map_id UUID;
    _map_pool_id UUID;
    _map_pool UUID[];
    _map_pool_count int;
    _best_of int;
BEGIN
    SELECT map_pool_id, best_of INTO _map_pool_id, _best_of FROM match_options WHERE id = _match_options_id;

    SELECT array_agg(map_id) INTO _map_pool FROM _map_pool WHERE map_pool_id = _map_pool_id;

    _map_pool_count = array_length(_map_pool, 1);

    IF _map_pool_count = 0 THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Match requires at least one map selected';
    END IF;

    IF _best_of > _map_pool_count THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Not enough maps in the pool for the best of ' || _best_of;
    END IF;

    SELECT map_id INTO _map_id FROM _map_pool WHERE map_pool_id = _map_pool_id LIMIT 1;

    IF _map_pool_count = _best_of THEN 
        FOR i IN 1.._best_of LOOP
            INSERT INTO match_maps (match_id, map_id, "order", lineup_1_side, lineup_2_side)
            VALUES (_match_id, _map_pool[i], i, 
                    CASE WHEN i % 2 = 1 THEN 'CT' ELSE 'TERRORIST' END, 
                    CASE WHEN i % 2 = 1 THEN 'TERRORIST' ELSE 'CT' END);
        END LOOP;
    END IF;
END;
$$;