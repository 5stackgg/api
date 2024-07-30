CREATE OR REPLACE FUNCTION public.is_captain(match public.matches, hasura_session json) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM match_lineups ml
        WHERE 
            (ml.id = match.lineup_1_id OR ml.id = match.lineup_2_id)
            AND ml.coach_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
    );
END;
$$;
