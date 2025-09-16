CREATE OR REPLACE FUNCTION public.taud_match_streams()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    affected_match_id uuid;
    deleted_priority int;
BEGIN
    BEGIN
        PERFORM 1 FROM pg_temp.taud_match_streams_running_flag LIMIT 1;
        RETURN COALESCE(NEW, OLD);
    EXCEPTION
        WHEN undefined_table THEN
            NULL;
    END;

    CREATE TEMP TABLE taud_match_streams_running_flag (dummy int);

    BEGIN
        affected_match_id := COALESCE(OLD.match_id, NEW.match_id);

        IF TG_OP = 'DELETE' THEN
            -- Compact priorities after deletion: shift down all items after the deleted position
            deleted_priority := OLD.priority;
            UPDATE match_streams
            SET priority = priority - 1
            WHERE match_id = affected_match_id
              AND priority > deleted_priority;

        ELSIF TG_OP = 'UPDATE' AND NEW.priority IS DISTINCT FROM OLD.priority THEN
            IF NEW.priority < OLD.priority THEN
                -- Moving up: push down items in [NEW.priority, OLD.priority)
                UPDATE match_streams
                SET priority = priority + 1
                WHERE match_id = affected_match_id
                  AND priority >= NEW.priority
                  AND priority < OLD.priority
                  AND id != NEW.id;
            ELSIF NEW.priority > OLD.priority THEN
                -- Moving down: pull up items in (OLD.priority, NEW.priority]
                UPDATE match_streams
                SET priority = priority - 1
                WHERE match_id = affected_match_id
                  AND priority > OLD.priority
                  AND priority <= NEW.priority
                  AND id != NEW.id;
            END IF;
        END IF;
    EXCEPTION
        WHEN OTHERS THEN
            DROP TABLE IF EXISTS pg_temp.taud_match_streams_running_flag;
            RAISE;
    END;

    DROP TABLE IF EXISTS pg_temp.taud_match_streams_running_flag;

    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS taud_match_streams ON public.match_streams;
CREATE TRIGGER taud_match_streams AFTER UPDATE OR DELETE ON public.match_streams FOR EACH ROW EXECUTE FUNCTION public.taud_match_streams();