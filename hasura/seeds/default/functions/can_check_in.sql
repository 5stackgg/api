CREATE OR REPLACE FUNCTION public.can_check_in(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
BEGIN
    IF NOT is_in_lineup(match, hasura_session) THEN
        RETURN false;
    END IF;

    IF match.status != 'WaitingForCheckIn' THEN
        RETURN false;
    END IF;

    RETURN true;
END;
$$;
