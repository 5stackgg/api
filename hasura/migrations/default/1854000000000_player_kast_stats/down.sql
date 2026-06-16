ALTER TABLE public.player_match_map_stats
  DROP COLUMN IF EXISTS kast_rounds,
  DROP COLUMN IF EXISTS kast_total_rounds;
