CREATE OR REPLACE FUNCTION public.tai_lobbies()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO lobby_players (lobby_id, steam_id, captain, status)
    VALUES (NEW.id, (current_setting('hasura.user')::jsonb->>'x-hasura-user-id')::bigint, TRUE, 'Accepted');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tai_lobbies ON public.lobbies;
CREATE OR REPLACE TRIGGER tai_lobbies
    AFTER INSERT ON lobbies
    FOR EACH ROW
    EXECUTE FUNCTION public.tai_lobbies();
