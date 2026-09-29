-- A self-join carries the joiner as invited_by (the insert preset), so only a
-- row naming somebody else is an invitation.
CREATE OR REPLACE FUNCTION public.tbi_lobby_players()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.invited_by_steam_id IS NOT NULL AND NEW.invited_by_steam_id <> NEW.steam_id THEN
        PERFORM public.assert_not_blocked(NEW.invited_by_steam_id, NEW.steam_id);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tbi_lobby_players ON public.lobby_players;
CREATE TRIGGER tbi_lobby_players
    BEFORE INSERT ON lobby_players
    FOR EACH ROW
    EXECUTE FUNCTION public.tbi_lobby_players();


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
    -- An invite going away (declined, withdrawn, cleared by a block) is not a
    -- member leaving, so it hands nobody the captaincy.
    IF OLD.status <> 'Accepted' THEN
        RETURN OLD;
    END IF;

    SELECT COUNT(*) INTO remaining_players
    FROM lobby_players
    WHERE lobby_id = OLD.lobby_id
    and status = 'Accepted';

    IF remaining_players = 0 THEN
        DELETE FROM lobbies WHERE id = OLD.lobby_id;
    ELSIF NOT EXISTS (
        SELECT 1
        FROM lobby_players
        WHERE lobby_id = OLD.lobby_id
        AND status = 'Accepted'
        AND captain = TRUE
    ) THEN
        -- A member whose own leave is still uncommitted is locked; picking them
        -- would promote nobody once that leave commits.
        UPDATE lobby_players SET captain = TRUE
        WHERE lobby_id = OLD.lobby_id
        AND steam_id = (
            SELECT steam_id 
            FROM lobby_players
            WHERE lobby_id = OLD.lobby_id
            AND status = 'Accepted'
            AND captain = FALSE
            ORDER BY steam_id
            FETCH FIRST 1 ROW ONLY
            FOR UPDATE SKIP LOCKED
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
