-- active_matches() reads only these rows; a status filter sent at run time
-- can still narrow by the leading column.
CREATE INDEX IF NOT EXISTS idx_matches_active
    ON public.matches (status, created_at DESC)
    WHERE status IN ('Live', 'Veto', 'WaitingForCheckIn', 'WaitingForServer', 'Scheduled', 'PickingPlayers');
