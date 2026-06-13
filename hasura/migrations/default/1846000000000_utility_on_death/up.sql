ALTER TABLE public.player_trade_stats_demo
  ADD COLUMN IF NOT EXISTS util_on_death_sum   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS util_on_death_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.player_match_map_stats
  ADD COLUMN IF NOT EXISTS util_on_death_sum   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS util_on_death_count integer NOT NULL DEFAULT 0;
