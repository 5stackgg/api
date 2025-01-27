CREATE OR REPLACE FUNCTION public.get_player_current_lobby_id(player players, hasura_session json)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    lobby_id uuid;
BEGIN
    SELECT l.id INTO lobby_id
    FROM lobbies l
    INNER JOIN lobby_players lp ON lp.lobby_id = l.id
    WHERE
    lp.steam_id = player.steam_id
    AND lp.status = 'Accepted'
    AND (
        hasura_session ->> 'x-hasura-role' = 'admin'
        OR
        l.access = 'Open'
        OR
        player.steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
        OR
        l.access = 'Friends'
        AND EXISTS (
            SELECT 1 
            FROM lobby_players lp2
            INNER JOIN players p ON p.steam_id = lp2.steam_id 
            INNER JOIN v_my_friends f ON f.friend_steam_id = p.steam_id
            WHERE lp2.lobby_id = l.id
            AND f.steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
        )
    );

    RETURN lobby_id;
END;
$function$
