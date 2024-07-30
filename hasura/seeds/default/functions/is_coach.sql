CREATE OR REPLACE FUNCTION public.is_coach(match public.matches, hasura_session json) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
BEGIN
   	return SELECT EXISTS (
               SELECT 1
               FROM match_lineups ml
               WHERE
                ml.id = match.lineup_1_id OR ml.id = lineup_2_id
                AND coach_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
           )
END;
$$;