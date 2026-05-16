drop index if exists "public"."match_clips_match_map_round_idx";

alter table "public"."match_clips"
  drop column if exists "round";
