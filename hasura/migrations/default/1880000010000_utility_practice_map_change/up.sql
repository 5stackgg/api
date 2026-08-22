-- The map a practice server is on used to be fixed for the life of the session:
-- it was chosen when the server was booked and nothing anywhere could move it.
-- Switching maps on the website therefore stranded the server on the old one,
-- and a lineup for another map could only be practised by throwing the server
-- away and booking a new one.
--
-- map_name moves the moment a switch is accepted, but the level takes ~15s to
-- load. Without a separate "in flight" mark every surface that compares its map
-- to the session's goes true immediately, and a load sent into that gap lands on
-- a player the server does not have yet -- reported as sent, silently doing
-- nothing. Cleared when the plugin fetches its session while reporting the new
-- map, which is exactly the moment the level finished loading.
ALTER TABLE public.utility_practice_sessions
    ADD COLUMN IF NOT EXISTS map_changing_at timestamptz;
