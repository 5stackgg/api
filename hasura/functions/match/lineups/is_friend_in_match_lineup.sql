CREATE OR REPLACE FUNCTION public.is_friend_in_match_lineup(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM match_lineup_players mlp
        JOIN friends f
          ON (f.player_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
              AND f.other_player_steam_id = mlp.steam_id)
          OR (f.other_player_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
              AND f.player_steam_id = mlp.steam_id)
        WHERE mlp.match_lineup_id IN (match.lineup_1_id, match.lineup_2_id)
    )
$$;
