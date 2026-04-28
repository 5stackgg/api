alter table "public"."match_streams"
  add column if not exists "is_game_streamer" boolean not null default false;

create index if not exists "match_streams_is_game_streamer_idx"
  on "public"."match_streams" ("match_id")
  where "is_game_streamer";

alter table "public"."match_streams"
  add column if not exists "is_live" boolean not null default true;

alter table "public"."match_streams"
  add column if not exists "status" text,
  add column if not exists "stream_url" text,
  add column if not exists "error_message" text,
  add column if not exists "last_status_at" timestamptz;

update "public"."match_streams"
  set "status" = case when "is_live" then 'live' else 'launching_steam' end
  where "is_game_streamer" and "status" is null;

alter table "public"."match_streams"
  add column if not exists "autodirector" boolean not null default true;
