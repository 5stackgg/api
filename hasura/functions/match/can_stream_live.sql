-- Whether the operator can start a "live" (direct, no-GOTV-delay) game
-- streamer for this match right now. Live mode connects the streamer pod
-- straight to the game port, so it's available the moment a server is
-- assigned and the match has gone Live. The actual mutation handler
-- re-checks organizer status server-side.
CREATE OR REPLACE FUNCTION public.can_stream_live(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    IF NOT is_match_organizer(match, hasura_session) THEN
        RETURN false;
    END IF;

    IF match.status <> 'Live' THEN
        RETURN false;
    END IF;

    IF match.server_id IS NULL THEN
        RETURN false;
    END IF;

    RETURN true;
END;
$$;
