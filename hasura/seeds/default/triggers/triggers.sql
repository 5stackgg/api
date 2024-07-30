







DROP TRIGGER IF EXISTS ti_v_pool_maps ON public.v_pool_maps;
CREATE TRIGGER ti_v_pool_maps INSTEAD OF INSERT ON public.v_pool_maps FOR EACH ROW EXECUTE FUNCTION public.insert_into_v_map_pools();
