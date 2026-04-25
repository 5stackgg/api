-- Track whether a game-streamer row is actually streamable yet.
-- Lifecycle (only relevant for is_game_streamer = true rows):
--   row inserted on startLive with is_live = false  → "booting"
--   updated to true once mediamtx confirms the publish path → "live"
--   row deleted on stopLive
-- User-added rows (is_game_streamer = false) are always considered live.
alter table "public"."match_streams"
  add column if not exists "is_live" boolean not null default true;
