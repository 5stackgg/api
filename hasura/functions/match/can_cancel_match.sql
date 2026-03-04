CREATE OR REPLACE FUNCTION public.can_cancel_match(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    IF NOT is_match_organizer(match, hasura_session) THEN
        RETURN false;
    END IF;

    IF match.status IN ('Finished', 'Tie', 'Canceled', 'Forfeit', 'Surrendered') THEN
        RETURN false;
    END IF;

    RETURN true;
END;
$$;
