CREATE OR REPLACE FUNCTION public.match_requested_organizer(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    notification_count integer;
BEGIN
    IF NOT is_match_organizer(match, hasura_session) AND NOT is_in_lineup(match, hasura_session) THEN
        RETURN false;
    END IF;


    SELECT COUNT(*) INTO notification_count from notifications where entity_id = match.id::text AND type = 'MatchSupport' AND is_read = false;

    IF notification_count > 0 THEN
        RETURN true;
    END IF;

    RETURN false;
END;
$$;
