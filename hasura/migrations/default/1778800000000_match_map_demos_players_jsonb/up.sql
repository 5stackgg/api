alter table "public"."match_map_demos"
  add column if not exists "players" jsonb null;
