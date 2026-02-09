CREATE OR REPLACE FUNCTION public.is_in_lineup(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM match_lineup_players mlp
        WHERE mlp.match_lineup_id IN (match.lineup_1_id, match.lineup_2_id)
          AND mlp.steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
    )
$$;
