alter table "public"."match_demo_sessions"
  drop constraint if exists match_demo_sessions_progress_chk,
  drop column if exists "progress_stage",
  drop column if exists "progress";

alter table "public"."match_streams"
  drop constraint if exists match_streams_progress_chk,
  drop column if exists "progress_stage",
  drop column if exists "progress";
