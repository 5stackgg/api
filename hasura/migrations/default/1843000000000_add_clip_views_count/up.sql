alter table "public"."match_clips"
  add column if not exists "views_count" integer not null default 0;
