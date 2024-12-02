CREATE OR REPLACE FUNCTION public.tbau_players() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
BEGIN
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
