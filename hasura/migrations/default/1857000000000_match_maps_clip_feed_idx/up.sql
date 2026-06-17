-- Plain (not partial) so the highlights feed's parameterized clips-count filter
-- can still use the index for ordering; NULLS LAST keeps clip rows at the front.
drop index if exists "public"."match_maps_public_latest_clip_at_idx";
create index if not exists "match_maps_public_latest_clip_at_idx"
  on "public"."match_maps" ("public_latest_clip_at" desc nulls last);

drop index if exists "public"."match_maps_latest_clip_at_idx";
create index if not exists "match_maps_latest_clip_at_idx"
  on "public"."match_maps" ("latest_clip_at" desc nulls last);
