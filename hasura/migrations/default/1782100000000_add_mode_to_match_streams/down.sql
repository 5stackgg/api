alter table "public"."match_streams"
  drop constraint if exists "match_streams_mode_check";

alter table "public"."match_streams"
  drop column if exists "mode";
