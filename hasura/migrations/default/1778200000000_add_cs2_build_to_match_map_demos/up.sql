alter table "public"."match_map_demos"
  add column if not exists "cs2_build" text null;
