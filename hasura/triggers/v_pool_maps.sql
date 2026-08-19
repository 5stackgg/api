CREATE OR REPLACE FUNCTION public.ti_v_pool_maps() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM maps WHERE id = NEW.id AND deleted_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Map % has been deleted and cannot be added to a map pool', NEW.id USING ERRCODE = '22000';
    END IF;

 	INSERT INTO _map_pool (map_id, map_pool_id)
    VALUES (NEW.id, NEW.map_pool_id);
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ti_v_pool_maps ON public.v_pool_maps;
CREATE TRIGGER ti_v_pool_maps INSTEAD OF INSERT ON public.v_pool_maps FOR EACH ROW EXECUTE FUNCTION public.ti_v_pool_maps();

CREATE OR REPLACE FUNCTION public.tu_v_pool_maps() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE public._map_pool
  SET map_pool_id = NEW.map_pool_id,
      map_id = NEW.id
  WHERE map_pool_id = OLD.map_pool_id AND map_id = OLD.id;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tu_v_pool_maps ON public.v_pool_maps;
CREATE TRIGGER tu_v_pool_maps INSTEAD OF UPDATE ON public.v_pool_maps FOR EACH ROW EXECUTE FUNCTION public.tu_v_pool_maps();

CREATE OR REPLACE FUNCTION public.td_v_pool_maps() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM public._map_pool
  WHERE map_pool_id = OLD.map_pool_id AND map_id = OLD.id;
  
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS td_v_pool_maps ON public.v_pool_maps;
CREATE TRIGGER td_v_pool_maps INSTEAD OF DELETE ON public.v_pool_maps FOR EACH ROW EXECUTE FUNCTION public.td_v_pool_maps(); 