CREATE FUNCTION public.add_owner_to_team() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO team_roster (team_id, role, player_steam_id)
    VALUES (NEW.id, 'Admin', NEW.owner_steam_id);
	RETURN NEW;
END;
$$;