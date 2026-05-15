ALTER TABLE public.player_match_map_stats
  ADD COLUMN IF NOT EXISTS trade_kill_opportunities   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trade_kill_attempts        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trade_kill_successes       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS traded_death_opportunities integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS traded_death_successes     integer NOT NULL DEFAULT 0;
