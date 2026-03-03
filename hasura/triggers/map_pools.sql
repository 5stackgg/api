CREATE OR REPLACE FUNCTION public.tau__map_pool() RETURNS TRIGGER
    LANGUAGE plpgsql
AS $$
DECLARE
    _map_pool_id UUID;
    match_rec RECORD;
BEGIN
    -- Handle affected map_pool_ids once per statement using transition tables
    IF TG_OP = 'INSERT' THEN
        FOR _map_pool_id IN
            SELECT DISTINCT map_pool_id FROM new_rows
        LOOP
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
        END LOOP;
    ELSIF TG_OP = 'DELETE' THEN
        FOR _map_pool_id IN
            SELECT DISTINCT map_pool_id FROM old_rows
        LOOP
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
        END LOOP;
    ELSIF TG_OP = 'UPDATE' THEN
        -- Updates can move rows between pools, so consider both old and new ids
        FOR _map_pool_id IN
            SELECT DISTINCT map_pool_id FROM (
                SELECT map_pool_id FROM new_rows
                UNION
                SELECT map_pool_id FROM old_rows
            ) s
        LOOP
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
        END LOOP;
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tau__map_pool ON public._map_pool;
DROP TRIGGER IF EXISTS tau__map_pool_insert ON public._map_pool;
DROP TRIGGER IF EXISTS tau__map_pool_update ON public._map_pool;
DROP TRIGGER IF EXISTS tau__map_pool_delete ON public._map_pool;

-- One trigger per event, because PostgreSQL does not allow
-- transition tables on triggers with more than one event.
CREATE TRIGGER tau__map_pool_insert
AFTER INSERT ON public._map_pool
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.tau__map_pool();

CREATE TRIGGER tau__map_pool_update
AFTER UPDATE ON public._map_pool
REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.tau__map_pool();

CREATE TRIGGER tau__map_pool_delete
AFTER DELETE ON public._map_pool
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.tau__map_pool();

