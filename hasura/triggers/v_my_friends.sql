CREATE OR REPLACE FUNCTION public.ti_v_my_friends() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    my_steam_id bigint;
BEGIN
    my_steam_id := (current_setting('hasura.user', true)::jsonb ->> 'x-hasura-user-id')::bigint;

    INSERT INTO friends (player_steam_id, other_player_steam_id, status)
    VALUES (my_steam_id, NEW.steam_id, 'Pending');
    RETURN NULL;
END;
$$;


CREATE OR REPLACE FUNCTION public.tu_v_my_friends() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    my_steam_id bigint;
BEGIN
    my_steam_id := (current_setting('hasura.user', true)::jsonb ->> 'x-hasura-user-id')::bigint;

    UPDATE friends 
    SET status = 'Accepted'
    WHERE player_steam_id = OLD.steam_id AND other_player_steam_id = my_steam_id;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.td_v_my_friends() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    my_steam_id bigint;
BEGIN
    my_steam_id := (current_setting('hasura.user', true)::jsonb ->> 'x-hasura-user-id')::bigint;

    DELETE FROM friends 
    WHERE 
    (player_steam_id = my_steam_id  AND other_player_steam_id = OLD.steam_id)
    OR (player_steam_id = OLD.steam_id  AND other_player_steam_id = my_steam_id);
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ti_v_my_friends ON public.v_my_friends;
CREATE TRIGGER ti_v_my_friends INSTEAD OF INSERT ON public.v_my_friends FOR EACH ROW EXECUTE FUNCTION public.ti_v_my_friends();


DROP TRIGGER IF EXISTS tu_v_my_friends ON public.v_my_friends;
CREATE TRIGGER tu_v_my_friends INSTEAD OF UPDATE ON public.v_my_friends FOR EACH ROW EXECUTE FUNCTION public.tu_v_my_friends();

DROP TRIGGER IF EXISTS td_v_my_friends ON public.v_my_friends;
CREATE TRIGGER td_v_my_friends INSTEAD OF DELETE ON public.v_my_friends FOR EACH ROW EXECUTE FUNCTION public.td_v_my_friends();
