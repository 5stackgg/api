alter table "public"."match_streams"
  add column if not exists "mode" text not null default 'tv';

alter table "public"."match_streams"
  add constraint "match_streams_mode_check" check ("mode" in ('live', 'tv'));
