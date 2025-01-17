CREATE OR REPLACE FUNCTION public.taiu_lobby_players()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'Accepted' THEN
        DELETE FROM lobby_players WHERE lobby_id != NEW.lobby_id and steam_id = NEW.steam_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS taiu_lobby_players ON public.lobby_players;
CREATE TRIGGER taiu_lobby_players
    AFTER INSERT OR UPDATE ON lobby_players
    FOR EACH ROW
    EXECUTE FUNCTION public.taiu_lobby_players();


CREATE OR REPLACE FUNCTION public.tad_lobby_players()
RETURNS TRIGGER AS $$
DECLARE
    remaining_players integer;
BEGIN
    SELECT COUNT(*) INTO remaining_players
    FROM lobby_players
    WHERE lobby_id = OLD.lobby_id
    and status = 'Accepted';

    IF remaining_players = 0 THEN
        DELETE FROM lobbies WHERE id = OLD.lobby_id;
    ELSE
        UPDATE lobby_players SET captain = TRUE
        WHERE steam_id = (
            SELECT steam_id 
            FROM lobby_players
            WHERE lobby_id = OLD.lobby_id
            AND status = 'Accepted'
            AND captain = FALSE
            ORDER BY steam_id
            FETCH FIRST 1 ROW ONLY
        );
    END IF;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tad_lobby_players ON public.lobby_players;
CREATE TRIGGER tad_lobby_players
    AFTER DELETE ON lobby_players
    FOR EACH ROW
    EXECUTE FUNCTION public.tad_lobby_players();
