-- Whether the operator can start a "live" (direct, no-GOTV-delay) game
-- streamer for this match right now. Live mode connects the streamer pod
-- straight to the game port, so it's available the moment a server is
-- assigned and the match has gone Live. The actual mutation handler
-- re-checks organizer status server-side.
CREATE OR REPLACE FUNCTION public.can_stream_live(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT match.status = 'Live'
        AND match.server_id IS NOT NULL
        AND is_match_organizer(match, hasura_session);
$$;
