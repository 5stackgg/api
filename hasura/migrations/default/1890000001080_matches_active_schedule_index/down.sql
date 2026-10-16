CREATE INDEX IF NOT EXISTS idx_match_lineup_players_steam_id
    ON public.match_lineup_players (steam_id);
DROP INDEX IF EXISTS public.idx_matches_active_schedule;
