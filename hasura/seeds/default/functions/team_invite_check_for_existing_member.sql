CREATE OR REPLACE FUNCTION public.team_invite_check_for_existing_member() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	 IF EXISTS (SELECT 1 FROM team_roster WHERE team_id = NEW.team_id AND player_steam_id = NEW.steam_id) THEN
		RAISE EXCEPTION 'Player already on team.';
    END IF;
    RETURN NEW;
END;
$$;