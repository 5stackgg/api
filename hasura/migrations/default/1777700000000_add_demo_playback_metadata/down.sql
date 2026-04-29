alter table "public"."match_map_demos"
  drop column if exists "metadata_parsed_at",
  drop column if exists "round_ticks",
  drop column if exists "duration_seconds",
  drop column if exists "tick_rate",
  drop column if exists "total_ticks",
  drop column if exists "workshop_id",
  drop column if exists "map_name"
  drop column if exists "bombs",
  drop column if exists "kills";
