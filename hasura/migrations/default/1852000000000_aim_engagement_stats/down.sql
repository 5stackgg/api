ALTER TABLE public.player_match_map_stats
  DROP COLUMN IF EXISTS first_bullet_shots,
  DROP COLUMN IF EXISTS first_bullet_hits,
  DROP COLUMN IF EXISTS on_target_frames,
  DROP COLUMN IF EXISTS total_engagement_frames;

ALTER TABLE public.player_aim_stats_demo
  DROP COLUMN IF EXISTS first_bullet_shots,
  DROP COLUMN IF EXISTS first_bullet_hits,
  DROP COLUMN IF EXISTS on_target_frames,
  DROP COLUMN IF EXISTS total_engagement_frames;
