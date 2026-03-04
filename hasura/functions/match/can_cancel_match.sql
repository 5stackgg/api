CREATE OR REPLACE FUNCTION public.can_cancel_match(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    _auto_cancel_mode text;
    _user_role text;
BEGIN
    IF NOT is_match_organizer(match, hasura_session) THEN
        RETURN false;
    END IF;

    IF match.status IN ('Finished', 'Tie', 'Canceled', 'Forfeit', 'Surrendered') THEN
        RETURN false;
    END IF;

    -- Admin-only cancel: restrict to privileged roles
    SELECT mo.auto_cancel_mode INTO _auto_cancel_mode
    FROM match_options mo WHERE mo.id = match.match_options_id;

    IF _auto_cancel_mode = 'Admin' THEN
        _user_role := hasura_session ->> 'x-hasura-role';
        IF _user_role NOT IN ('admin', 'administrator', 'tournament_organizer', 'match_organizer') THEN
            RETURN false;
        END IF;
    END IF;

    RETURN true;
END;
$$;
