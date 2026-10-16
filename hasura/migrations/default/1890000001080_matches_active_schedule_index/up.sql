-- is_in_another_match and get_player_live_lineup start from the active
-- matches: the active statuses, plus Scheduled matches by start time so the
-- ones further out are never read.
CREATE INDEX IF NOT EXISTS idx_matches_active_schedule
    ON public.matches (status, scheduled_at)
    INCLUDE (id, lineup_1_id, lineup_2_id, source)
    WHERE status IN ('Veto', 'WaitingForCheckIn', 'WaitingForServer', 'Live', 'Scheduled');
