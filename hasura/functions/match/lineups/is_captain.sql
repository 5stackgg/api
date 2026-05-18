CREATE OR REPLACE FUNCTION public.is_captain(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM match_lineups ml
        INNER JOIN match_lineup_players mlp ON mlp.match_lineup_id = ml.id
        WHERE ml.match_id = match.id
          AND mlp.steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
          AND mlp.captain = true
    );
$$;

CREATE OR REPLACE FUNCTION public.is_captain_on_lineup(match_lineup public.match_lineups, hasura_session json)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM match_lineup_players mlp
        WHERE mlp.match_lineup_id = match_lineup.id
          AND mlp.steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
          AND mlp.captain = true
    );
$$;
