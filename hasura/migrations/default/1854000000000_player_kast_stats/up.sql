-- KAST is a per-round flag (Kill / Assist / Survive / Trade) derived from the
-- immutable per-round event tables. It used to be recomputed on every read by
-- v_player_match_map_hltv (correlated EXISTS against the player_kills
-- hypertable), which made the rating views take seconds. We now compute it once
-- per map in recompute_player_match_map_stats and store it here, so the HLTV
-- view and everything built on it (career / performance ratings) read a column.
ALTER TABLE public.player_match_map_stats
  ADD COLUMN IF NOT EXISTS kast_rounds       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS kast_total_rounds integer NOT NULL DEFAULT 0;
