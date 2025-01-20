CREATE OR REPLACE FUNCTION public.ti_v_pool_maps() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 	INSERT INTO _map_pool (map_id, map_pool_id)
    VALUES (NEW.id, NEW.map_pool_id);
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ti_v_pool_maps ON public.v_pool_maps;
CREATE TRIGGER ti_v_pool_maps INSTEAD OF INSERT ON public.v_pool_maps FOR EACH ROW EXECUTE FUNCTION public.ti_v_pool_maps();
