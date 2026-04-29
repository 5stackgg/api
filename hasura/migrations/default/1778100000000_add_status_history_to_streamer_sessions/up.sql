alter table "public"."match_streams"
  add column if not exists "status_history" jsonb not null default '[]'::jsonb;

alter table "public"."match_demo_sessions"
  add column if not exists "status_history" jsonb not null default '[]'::jsonb;
