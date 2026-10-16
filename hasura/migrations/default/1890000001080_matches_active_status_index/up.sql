-- is_in_another_match and get_player_live_lineup start from the active
-- matches, so the partial index has to hold every status they look for.
DROP INDEX IF EXISTS public.idx_matches_status_lineup;
CREATE INDEX idx_matches_status_lineup
    ON public.matches (status, lineup_1_id, lineup_2_id)
    WHERE status IN ('Veto', 'WaitingForCheckIn', 'WaitingForServer', 'Live', 'Scheduled');
