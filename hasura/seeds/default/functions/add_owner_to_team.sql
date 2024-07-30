CREATE OR REPLACE FUNCTION public.add_owner_to_team(team teams) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO team_roster (team_id, role, player_steam_id)
    VALUES (team.id, 'Admin', team.owner_steam_id);
END;
$$;