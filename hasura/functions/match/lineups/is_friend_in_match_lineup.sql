CREATE OR REPLACE FUNCTION public.is_friend_in_match_lineup(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM match_lineup_players mlp
        WHERE mlp.match_lineup_id IN (match.lineup_1_id, match.lineup_2_id)
          AND mlp.steam_id IN (
              SELECT other_player_steam_id
                FROM friends
               WHERE player_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
              UNION ALL
              SELECT player_steam_id
                FROM friends
               WHERE other_player_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
          )
    )
$$;
