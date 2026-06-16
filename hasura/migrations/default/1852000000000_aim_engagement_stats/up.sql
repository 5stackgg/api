-- Per-engagement aim metrics: first-bullet accuracy and time-on-target, stored
-- as sums/counts so the match-level view can average them.
ALTER TABLE public.player_aim_stats_demo
  ADD COLUMN IF NOT EXISTS first_bullet_shots      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_bullet_hits       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS on_target_frames        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_engagement_frames integer NOT NULL DEFAULT 0;

ALTER TABLE public.player_match_map_stats
  ADD COLUMN IF NOT EXISTS first_bullet_shots      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_bullet_hits       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS on_target_frames        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_engagement_frames integer NOT NULL DEFAULT 0;
