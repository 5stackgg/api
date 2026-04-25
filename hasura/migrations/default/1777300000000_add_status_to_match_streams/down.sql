alter table "public"."match_streams"
  drop column if exists "last_status_at",
  drop column if exists "error_message",
  drop column if exists "stream_url",
  drop column if exists "status";
