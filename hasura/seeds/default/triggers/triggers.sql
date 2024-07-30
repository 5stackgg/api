





DROP TRIGGER IF EXISTS tbiu_update_total_damage_trigger ON public.player_damages;
CREATE TRIGGER tbiu_update_total_damage_trigger BEFORE INSERT OR UPDATE ON public.player_damages FOR EACH ROW EXECUTE FUNCTION public.update_total_damage();

DROP TRIGGER IF EXISTS tbu_match_player_count ON public.matches;
CREATE TRIGGER tbu_match_player_count BEFORE UPDATE ON public.matches FOR EACH ROW EXECUTE FUNCTION public.tbu_match_player_count();

DROP TRIGGER IF EXISTS tbu_match_status ON public.matches;
CREATE TRIGGER tbu_match_status BEFORE UPDATE ON public.matches FOR EACH ROW EXECUTE FUNCTION public.tbu_match_status();

DROP TRIGGER IF EXISTS tbui_match_lineup_players ON public.match_lineup_players;
CREATE TRIGGER tbui_match_lineup_players BEFORE INSERT OR UPDATE ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.tbui_match_lineup_players();

DROP TRIGGER IF EXISTS ti_v_pool_maps ON public.v_pool_maps;
CREATE TRIGGER ti_v_pool_maps INSTEAD OF INSERT ON public.v_pool_maps FOR EACH ROW EXECUTE FUNCTION public.insert_into_v_map_pools();
