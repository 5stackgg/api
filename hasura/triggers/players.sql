CREATE OR REPLACE FUNCTION public.tbau_players() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
changing_player_role text;
changing_player_steam_id text;
changing_player_current_role text;
BEGIN
	IF TG_OP = 'UPDATE' AND NEW.role != OLD.role THEN
		SELECT current_setting('hasura.user', true)::jsonb ->> 'x-hasura-role' INTO changing_player_role;

		-- A GraphQL socket keeps the role it opened with until its session
		-- expires, so a demoted player's session can still claim the old one.
		-- 'admin' is the admin secret, and internal SQL has no session.
		IF changing_player_role IS NOT NULL AND changing_player_role != 'admin' THEN
			SELECT current_setting('hasura.user', true)::jsonb ->> 'x-hasura-user-id' INTO changing_player_steam_id;

			IF changing_player_steam_id ~ '^[0-9]{1,18}$' THEN
				SELECT role INTO changing_player_current_role
				FROM players
				WHERE steam_id = changing_player_steam_id::bigint;
			END IF;

			IF is_role_below(changing_player_role, changing_player_current_role) IS NOT TRUE THEN
				RAISE EXCEPTION 'Your role has changed, reload and try again' USING ERRCODE = '22000';
			END IF;
		END IF;

		IF NOT is_role_below(OLD.role, changing_player_role) THEN
			RAISE EXCEPTION 'You cannot change the role of a player above your own' USING ERRCODE = '22000';
		END IF;

		IF NOT is_role_below(NEW.role, changing_player_role) THEN
			RAISE EXCEPTION 'You cannot change the role of a player higher than yourself' USING ERRCODE = '22000';
		END IF;
	END IF;

	IF NEW.name_registered = true THEN
		IF EXISTS (
			SELECT 1 FROM players 
			WHERE name = NEW.name 
			AND steam_id != NEW.steam_id
			AND name_registered = true
		) THEN
			RAISE EXCEPTION 'Name is already registered by another player' USING ERRCODE = '22000';
		END IF;
	END IF;

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbau_players ON public.players;
CREATE TRIGGER tbau_players BEFORE INSERT OR UPDATE ON public.players FOR EACH ROW EXECUTE FUNCTION public.tbau_players();
