-- Per-map KAST rounds, precomputed by recompute_player_match_map_stats.
ALTER TABLE public.player_match_map_stats
  ADD COLUMN IF NOT EXISTS kast_rounds       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS kast_total_rounds integer NOT NULL DEFAULT 0;
