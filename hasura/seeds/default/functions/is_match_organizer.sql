CREATE OR REPLACE FUNCTION public.is_match_organizer(match public.matches, hasura_session json) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
BEGIN
    return match.organizer_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint;
END;
$$;
