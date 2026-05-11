-- Drops the table and file-managed objects that depend on it. After a down,
-- the file-managed function/view/trigger only re-apply when their digest
-- changes — touch the relevant file to force a re-apply.

DROP TRIGGER IF EXISTS tai_match_map_rounds_recompute_stats ON public.match_map_rounds;
DROP FUNCTION IF EXISTS public.tai_match_map_rounds_recompute_stats();
DROP FUNCTION IF EXISTS public.recompute_player_match_map_stats(uuid);
DROP VIEW     IF EXISTS public.player_match_stats_v;
DROP TABLE    IF EXISTS public.player_match_map_stats;
