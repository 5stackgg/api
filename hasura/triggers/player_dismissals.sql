-- A player only ever dismisses on their own behalf; the owner comes from the
-- session rather than a per-role column preset.
DROP TRIGGER IF EXISTS tbi_player_dismissals_steam_id ON public.player_dismissals;
CREATE TRIGGER tbi_player_dismissals_steam_id
    BEFORE INSERT ON public.player_dismissals
    FOR EACH ROW EXECUTE FUNCTION public.tbi_stamp_session_steam_id('player_steam_id');
