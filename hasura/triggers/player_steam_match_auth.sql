CREATE OR REPLACE FUNCTION public.tbu_player_steam_match_auth()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tbu_player_steam_match_auth ON public.player_steam_match_auth;
CREATE OR REPLACE TRIGGER tbu_player_steam_match_auth
    BEFORE UPDATE ON public.player_steam_match_auth
    FOR EACH ROW
    EXECUTE FUNCTION public.tbu_player_steam_match_auth();
