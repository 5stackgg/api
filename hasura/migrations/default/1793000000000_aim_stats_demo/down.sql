ALTER TABLE public.player_match_map_stats
  DROP COLUMN IF EXISTS counter_strafed_shots,
  DROP COLUMN IF EXISTS counter_strafe_eligible_shots,
  DROP COLUMN IF EXISTS crosshair_angle_sum_deg,
  DROP COLUMN IF EXISTS crosshair_angle_count,
  DROP COLUMN IF EXISTS non_awp_hits,
  DROP COLUMN IF EXISTS hits_at_spotted,
  DROP COLUMN IF EXISTS shots_at_spotted;
DROP TABLE IF EXISTS public.player_aim_stats_demo;
