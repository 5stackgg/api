alter table "public"."match_clips"
  add column if not exists "kills_count" integer;

create index if not exists "match_clips_kills_count_idx"
  on "public"."match_clips" ("kills_count" desc nulls last);
