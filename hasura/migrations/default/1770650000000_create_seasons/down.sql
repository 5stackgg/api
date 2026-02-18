DROP FUNCTION IF EXISTS public.get_active_season();
DROP TABLE IF EXISTS public.player_season_stats;
DROP INDEX IF EXISTS idx_player_elo_season;
ALTER TABLE public.player_elo DROP COLUMN IF EXISTS season_id;
DROP TABLE IF EXISTS public.seasons;
