-- Add granular status tracking for game-streamer rows. The streamer pod
-- POSTs status updates to /game-streamer/:matchId/status as it walks
-- through its boot sequence; those writes land here.
--
-- Free-form text on purpose — operators want to read the current step at
-- a glance ("downloading_cs2", "logging_in") and the set evolves as we
-- add more granular reporting points without schema churn.
--
-- Only meaningful for is_game_streamer = true rows. User-added rows
-- ignore these columns.
alter table "public"."match_streams"
  add column if not exists "status" text,
  add column if not exists "stream_url" text,
  add column if not exists "error_message" text,
  add column if not exists "last_status_at" timestamptz;

update "public"."match_streams"
  set "status" = case when "is_live" then 'live' else 'launching_steam' end
  where "is_game_streamer" and "status" is null;
