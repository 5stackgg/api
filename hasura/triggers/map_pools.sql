CREATE OR REPLACE FUNCTION public.tau__map_pool() RETURNS TRIGGER
    LANGUAGE plpgsql
AS $$
DECLARE
    _map_pool_id UUID;
    match_rec RECORD;
BEGIN
    -- Determine which map_pool_id was affected
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        _map_pool_id := NEW.map_pool_id;
    ELSE
        _map_pool_id := OLD.map_pool_id;
    END IF;

    -- For all matches using this map pool that are in editable states,
    -- re-run setup_match_maps so their maps reflect the current pool.
    FOR match_rec IN
        SELECT
            m.id AS match_id,
            m.match_options_id AS match_options_id
        FROM matches m
        JOIN match_options mo ON mo.id = m.match_options_id
        WHERE mo.map_pool_id = _map_pool_id
          AND m.status IN ('Setup', 'PickingPlayers', 'WaitingForCheckIn', 'Veto')
    LOOP
        PERFORM setup_match_maps(match_rec.match_id, match_rec.match_options_id);
    END LOOP;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tau__map_pool ON public._map_pool;
CREATE TRIGGER tau__map_pool
AFTER INSERT OR UPDATE OR DELETE ON public._map_pool
FOR EACH ROW
EXECUTE FUNCTION public.tau__map_pool();

