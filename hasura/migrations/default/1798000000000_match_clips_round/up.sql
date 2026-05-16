alter table "public"."match_clips"
  add column if not exists "round" integer;

create index if not exists "match_clips_match_map_round_idx"
  on "public"."match_clips" ("match_map_id", "round");
