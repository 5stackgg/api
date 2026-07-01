DROP TABLE IF EXISTS public.player_season_stats;
DROP INDEX IF EXISTS public.idx_player_elo_season;
DROP INDEX IF EXISTS public.idx_player_elo_season_board;
ALTER TABLE public.player_elo DROP CONSTRAINT IF EXISTS player_elo_season_id_fkey;
ALTER TABLE public.player_elo DROP COLUMN IF EXISTS season_id;
DROP TABLE IF EXISTS public.seasons;

DROP FUNCTION IF EXISTS public.recompute_season_numbers() CASCADE;
DROP FUNCTION IF EXISTS public.tbi_seasons_mark_rebuild() CASCADE;
DROP FUNCTION IF EXISTS public.tai_seasons_reconcile() CASCADE;
DROP FUNCTION IF EXISTS public.rebuild_player_season_stats(uuid);
DROP FUNCTION IF EXISTS public.get_active_season();
DROP FUNCTION IF EXISTS public.season_for_timestamp(timestamptz);
DROP FUNCTION IF EXISTS public.seasons_enabled();

DELETE FROM public.settings WHERE name = 'public.seasons_enabled';
