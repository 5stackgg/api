drop index if exists "public"."match_streams_is_game_streamer_idx";

alter table "public"."match_streams"
  drop column if exists "is_game_streamer";
