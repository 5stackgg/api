CREATE OR REPLACE FUNCTION public.can_start_match(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
BEGIN
    IF (match.status != 'PickingPlayers' AND match.status != 'Scheduled') THEN
       return false;
    END IF;

    IF is_match_organizer(match, hasura_session) THEN
        RETURN true;
    END IF;

    TODO
    IF lineup_1_ready(match) and lineup_2_ready(match) THEN
            RETURN true;
    END IF;

    RETURN false;
END;
$$;
