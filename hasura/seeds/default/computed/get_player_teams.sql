
CREATE FUNCTION public.get_player_teams(player public.players) RETURNS SETOF public.teams
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
BEGIN
    RETURN QUERY
       SELECT DISTINCT t.*
        FROM players p
        LEFT JOIN team_roster tr on tr.player_steam_id = p.steam_id
        INNER JOIN teams t ON t.id = tr.team_id or t.owner_steam_id = player.steam_id
        where p.steam_id = player.steam_id;
END;
$$;