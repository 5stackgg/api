-- Whether the viewer and this player have a friends row either way round, of
-- any status: what the players.friends hop through v_my_friends answers, but
-- from two key lookups instead of building the viewer's whole friends list for
-- every player a friends-only permission asks about.
CREATE OR REPLACE FUNCTION public.is_friend(player public.players, hasura_session json)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM friends f
        WHERE f.player_steam_id = player.steam_id
          AND f.other_player_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
    ) OR EXISTS (
        SELECT 1
        FROM friends f
        WHERE f.player_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
          AND f.other_player_steam_id = player.steam_id
    );
$$;
