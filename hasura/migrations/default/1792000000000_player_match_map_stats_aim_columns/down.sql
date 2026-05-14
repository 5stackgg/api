ALTER TABLE public.player_match_map_stats
  DROP COLUMN IF EXISTS shots_fired,
  DROP COLUMN IF EXISTS hits,
  DROP COLUMN IF EXISTS headshot_hits,
  DROP COLUMN IF EXISTS time_to_damage_sum_s,
  DROP COLUMN IF EXISTS time_to_damage_count,
  DROP COLUMN IF EXISTS spotted_count,
  DROP COLUMN IF EXISTS spotted_with_damage_count,
  DROP COLUMN IF EXISTS he_throws,
  DROP COLUMN IF EXISTS molotov_throws,
  DROP COLUMN IF EXISTS smoke_throws,
  DROP COLUMN IF EXISTS decoy_throws,
  DROP COLUMN IF EXISTS rounds_played;
