ALTER TABLE public.player_match_map_stats
  DROP COLUMN IF EXISTS trade_kill_opportunities,
  DROP COLUMN IF EXISTS trade_kill_attempts,
  DROP COLUMN IF EXISTS trade_kill_successes,
  DROP COLUMN IF EXISTS traded_death_opportunities,
  DROP COLUMN IF EXISTS traded_death_successes;
