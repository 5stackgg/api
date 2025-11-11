CREATE OR REPLACE FUNCTION public.is_captain(match public.matches, hasura_session json) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM match_lineups ml
            INNER JOIN match_lineup_players mlp on mlp.match_lineup_id = ml.id
                WHERE
                    (ml.id = match.lineup_1_id OR ml.id = match.lineup_2_id)
                    AND mlp.steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
                    AND captain = true
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.is_captain_on_lineup(match_lineup public.match_lineups, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM match_lineup_players mlp
        WHERE mlp.match_lineup_id = match_lineup.id
        AND mlp.steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
        and mlp.captain = true
    );
END;
$$;
