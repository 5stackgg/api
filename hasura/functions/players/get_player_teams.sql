CREATE OR REPLACE FUNCTION public.get_player_teams(player public.players)
RETURNS SETOF public.teams
LANGUAGE sql STABLE
AS $$
    -- Teams where player is in the roster
    SELECT t.*
    FROM team_roster tr
    INNER JOIN teams t ON t.id = tr.team_id
    WHERE tr.player_steam_id = player.steam_id

    UNION

    -- Teams owned by the player
    SELECT t.*
    FROM teams t
    WHERE t.owner_steam_id = player.steam_id
$$;