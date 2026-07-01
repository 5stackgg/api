DROP INDEX IF EXISTS idx_player_elo_season;
DROP INDEX IF EXISTS idx_player_elo_season_board;
ALTER TABLE public.player_elo DROP COLUMN IF EXISTS season_id;
DROP TABLE IF EXISTS public.player_season_stats;
DROP TABLE IF EXISTS public.seasons;

DROP FUNCTION IF EXISTS public.recompute_season_numbers();
DROP FUNCTION IF EXISTS public.rebuild_player_season_stats(uuid);
DROP FUNCTION IF EXISTS public.get_active_season();
DROP FUNCTION IF EXISTS public.season_for_timestamp(timestamptz);
DROP FUNCTION IF EXISTS public.seasons_enabled();

DELETE FROM public.settings WHERE name = 'public.seasons_enabled';
