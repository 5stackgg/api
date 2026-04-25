-- match_streams rows owned by the 5Stack game-streamer (the per-match
-- streaming pod that publishes SourceTV to MediaMTX). Distinguished
-- from user-added rows so the API can manage their lifecycle exclusively.
alter table "public"."match_streams"
  add column if not exists "is_game_streamer" boolean not null default false;

-- Partial index — system rows are looked up by match_id during
-- start/stop and the readiness poll callback. Keeps the index tiny.
create index if not exists "match_streams_is_game_streamer_idx"
  on "public"."match_streams" ("match_id")
  where "is_game_streamer";
