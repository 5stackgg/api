CREATE OR REPLACE FUNCTION public.can_cancel_match(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
BEGIN
    IF is_match_organizer(match, hasura_session) AND (
        match.status != 'Finished' AND
        match.status != 'Tie' AND
        match.status != 'Canceled' AND
        match.status != 'Forfeit'
    ) THEN
        RETURN true;
    END IF;

    RETURN false;
END;
$$;
