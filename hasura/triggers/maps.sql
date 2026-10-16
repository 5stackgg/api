CREATE OR REPLACE FUNCTION public.tau_maps_soft_delete() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        -- Taken before the pool rows, the order update_map_pools() takes them in, or the two can deadlock.
        PERFORM pg_advisory_xact_lock(hashtext('update_map_pools'));
        DELETE FROM _map_pool WHERE map_id = NEW.id;
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tau_maps_soft_delete ON public.maps;
CREATE TRIGGER tau_maps_soft_delete AFTER UPDATE OF deleted_at ON public.maps FOR EACH ROW EXECUTE FUNCTION public.tau_maps_soft_delete();

CREATE OR REPLACE FUNCTION public.taiu_maps_sync_map_pools() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM update_map_pools();
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS taiu_maps_sync_map_pools ON public.maps;
CREATE TRIGGER taiu_maps_sync_map_pools AFTER INSERT OR UPDATE OF active_pool, enabled, deleted_at, type ON public.maps FOR EACH STATEMENT EXECUTE FUNCTION public.taiu_maps_sync_map_pools();
