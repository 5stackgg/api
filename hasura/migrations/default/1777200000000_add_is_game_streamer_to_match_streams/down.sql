drop index if exists "public"."match_streams_is_game_streamer_idx";

alter table "public"."match_streams"
  drop column if exists "is_game_streamer";

alter table "public"."match_streams"
  drop column if exists "is_live";

alter table "public"."match_streams"
  drop column if exists "last_status_at",
  drop column if exists "error_message",
  drop column if exists "stream_url",
  drop column if exists "status";

alter table "public"."match_streams"
  drop column if exists "autodirector";
