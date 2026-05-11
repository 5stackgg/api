CREATE OR REPLACE FUNCTION public.is_coach(match matches, hasura_session json)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $$
DECLARE
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM match_lineups ml
        WHERE
            ml.match_id = match.id
            AND ml.coach_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
    );
END;
$$
