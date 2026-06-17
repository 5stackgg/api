drop index if exists "public"."match_maps_public_latest_clip_at_idx";
create index if not exists "match_maps_public_latest_clip_at_idx"
  on "public"."match_maps" ("public_latest_clip_at" desc nulls last)
  where "public_clips_count" > 0;

drop index if exists "public"."match_maps_latest_clip_at_idx";
create index if not exists "match_maps_latest_clip_at_idx"
  on "public"."match_maps" ("latest_clip_at" desc nulls last)
  where "clips_count" > 0;
