ALTER TABLE public.player_aim_stats_demo
  ADD COLUMN IF NOT EXISTS non_awp_hits                  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hits_at_spotted               integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shots_at_spotted              integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS counter_strafe_eligible_shots integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS spray_shots                   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS spray_hits                    integer NOT NULL DEFAULT 0;

ALTER TABLE public.player_match_map_stats
  ADD COLUMN IF NOT EXISTS non_awp_hits                  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hits_at_spotted               integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shots_at_spotted              integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS counter_strafe_eligible_shots integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS spray_shots                   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS spray_hits                    integer NOT NULL DEFAULT 0;
