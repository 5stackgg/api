ALTER TABLE public.player_match_map_stats
  DROP COLUMN IF EXISTS util_on_death_sum,
  DROP COLUMN IF EXISTS util_on_death_count;
ALTER TABLE public.player_trades
  DROP COLUMN IF EXISTS util_on_death_sum,
  DROP COLUMN IF EXISTS util_on_death_count;
