ALTER TABLE public.player_match_map_stats
  ADD COLUMN IF NOT EXISTS shots_fired               integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hits                      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS headshot_hits             integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS time_to_damage_sum_s      numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS time_to_damage_count      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS spotted_count             integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS spotted_with_damage_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS he_throws                 integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS molotov_throws            integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS smoke_throws              integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS decoy_throws              integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rounds_played             integer NOT NULL DEFAULT 0;
