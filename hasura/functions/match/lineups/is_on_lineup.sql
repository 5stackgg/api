CREATE OR REPLACE FUNCTION public.is_on_lineup(match_lineup public.match_lineups, hasura_session json)
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
    );
END;
$$;
