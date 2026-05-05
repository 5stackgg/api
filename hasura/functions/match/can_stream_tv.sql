-- Whether the operator can start a "tv" (GOTV / Playcast, delayed) game
-- streamer for this match right now. TV mode reuses the existing
-- get_match_tv_connection_string() gate, so it implicitly waits for the
-- configured tv_delay to elapse and for either Playcast or a server-side
-- tv_port to be available.
CREATE OR REPLACE FUNCTION public.can_stream_tv(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    has_tv_port boolean;
    use_playcast text;
BEGIN
    IF NOT can_stream_live(match, hasura_session) THEN
        RETURN false;
    END IF;

    -- TV mode needs a path: Playcast enabled OR the server has a tv_port.
    use_playcast := get_setting('use_playcast', 'false');

    SELECT (s.tv_port IS NOT NULL) INTO has_tv_port
    FROM servers s
    WHERE s.id = match.server_id
    LIMIT 1;

    IF NOT (use_playcast = 'true' OR COALESCE(has_tv_port, false)) THEN
        RETURN false;
    END IF;

    -- Defer to the existing tv_delay/started_at gating.
    RETURN get_match_tv_connection_string(match, hasura_session) IS NOT NULL;
END;
$$;
