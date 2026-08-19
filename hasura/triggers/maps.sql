CREATE OR REPLACE FUNCTION public.tau_maps_soft_delete() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        DELETE FROM _map_pool WHERE map_id = NEW.id;
        RETURN NULL;
    END IF;

    IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
        PERFORM update_map_pools();
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tau_maps_soft_delete ON public.maps;
CREATE TRIGGER tau_maps_soft_delete AFTER UPDATE OF deleted_at ON public.maps FOR EACH ROW EXECUTE FUNCTION public.tau_maps_soft_delete();
