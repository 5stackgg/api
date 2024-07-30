








DROP TRIGGER IF EXISTS tbui_match_lineup_players ON public.match_lineup_players;
CREATE TRIGGER tbui_match_lineup_players BEFORE INSERT OR UPDATE ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.tbui_match_lineup_players();

DROP TRIGGER IF EXISTS ti_v_pool_maps ON public.v_pool_maps;
CREATE TRIGGER ti_v_pool_maps INSTEAD OF INSERT ON public.v_pool_maps FOR EACH ROW EXECUTE FUNCTION public.insert_into_v_map_pools();
