CREATE OR REPLACE FUNCTION public.is_in_lobby(player public.players)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM lobbies l
        INNER JOIN lobby_players lp ON lp.lobby_id = l.id
        WHERE lp.steam_id = player.steam_id
    );
$$;
