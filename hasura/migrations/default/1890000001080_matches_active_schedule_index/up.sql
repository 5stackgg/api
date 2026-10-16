-- is_in_another_match and get_player_live_lineup start from the active
-- matches: the active statuses, plus Scheduled matches by start time so the
-- ones further out are never read.
CREATE INDEX IF NOT EXISTS idx_matches_active_schedule
    ON public.matches (status, scheduled_at)
    INCLUDE (id, lineup_1_id, lineup_2_id, source)
    WHERE status IN ('Veto', 'WaitingForCheckIn', 'WaitingForServer', 'Live', 'Scheduled');

-- Both functions probe a lineup on (match_lineup_id, steam_id). An index on
-- steam_id alone costs the same to the planner, and when it wins that tie the
-- probe reads the player's whole history once per active match.
-- idx_match_lineup_players_steam_id_lineup_id still serves steam_id lookups.
DROP INDEX IF EXISTS public.idx_match_lineup_players_steam_id;
