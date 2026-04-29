alter table "public"."match_map_demos"
  add column if not exists "total_ticks" integer null,
  add column if not exists "tick_rate" real null,
  add column if not exists "duration_seconds" real
    generated always as (
      case when tick_rate is null or tick_rate = 0 then null
           else total_ticks::real / tick_rate
      end
    ) stored,
  add column if not exists "round_ticks" jsonb null,
  add column if not exists "metadata_parsed_at" timestamptz null,
  add column if not exists "map_name" text null,
  add column if not exists "workshop_id" text null
  add column if not exists "kills" jsonb null,
  add column if not exists "bombs" jsonb null;
