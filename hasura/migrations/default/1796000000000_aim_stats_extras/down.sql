ALTER TABLE public.player_match_map_stats
  DROP COLUMN IF EXISTS non_awp_hits,
  DROP COLUMN IF EXISTS hits_at_spotted,
  DROP COLUMN IF EXISTS shots_at_spotted,
  DROP COLUMN IF EXISTS counter_strafe_eligible_shots,
  DROP COLUMN IF EXISTS spray_shots,
  DROP COLUMN IF EXISTS spray_hits;

ALTER TABLE public.player_aim_stats_demo
  DROP COLUMN IF EXISTS non_awp_hits,
  DROP COLUMN IF EXISTS hits_at_spotted,
  DROP COLUMN IF EXISTS shots_at_spotted,
  DROP COLUMN IF EXISTS counter_strafe_eligible_shots,
  DROP COLUMN IF EXISTS spray_shots,
  DROP COLUMN IF EXISTS spray_hits;
