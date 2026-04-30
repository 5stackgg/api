alter table "public"."match_streams" drop column if exists "status_history";
alter table "public"."match_demo_sessions" drop column if exists "status_history";
