CREATE OR REPLACE FUNCTION public.can_check_in(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    _check_in_setting text;
BEGIN
    IF NOT is_in_lineup(match, hasura_session) THEN
        RETURN false;
    END IF;

    IF match.status != 'WaitingForCheckIn' THEN
        RETURN false;
    END IF;

    SELECT check_in_setting INTO _check_in_setting FROM match_options WHERE id = match.match_options_id;

    IF _check_in_setting = 'Admin' AND (hasura_session ->> 'x-hasura-role')::text != 'administrator' THEN
        RETURN false;
    END IF;

    IF _check_in_setting = 'Captains' AND NOT is_captain(match, hasura_session) THEN
        RETURN false;
    END IF;

    RETURN true;
END;
$$;
