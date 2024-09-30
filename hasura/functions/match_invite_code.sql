CREATE OR REPLACE FUNCTION public.match_invite_code(match public.matches, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    invite_code text;
BEGIN
    IF is_match_organizer(match, hasura_session) AND match.status = 'PickingPlayers' THEN
        SELECT mo.invite_code INTO invite_code
        FROM match_options mo
        WHERE mo.id = match.match_options_id;
    
        RETURN invite_code;
    END IF;

    RETURN NULL;
END;
$$;
