CREATE OR REPLACE FUNCTION public.can_assign_server_to_match(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
BEGIN
    IF is_match_organizer(match, hasura_session) AND (
        match.status != 'Tie' AND
        match.status != 'Canceled' AND
        match.status != 'Forfeit' AND
        match.status != 'Finished' AND
        match.status != 'Surrendered'
    ) THEN
        RETURN true;
    END IF;

    RETURN false;
END;
$$;
