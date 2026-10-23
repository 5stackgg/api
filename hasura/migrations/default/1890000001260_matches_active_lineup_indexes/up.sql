-- my_active_matches() finds a player's active matches from their own lineups
-- and as organizer; these hold just the active matches, so each lookup skips
-- every finished one.
CREATE INDEX IF NOT EXISTS idx_matches_active_lineup_1
    ON public.matches (lineup_1_id)
    WHERE status IN ('Live', 'Veto', 'WaitingForCheckIn', 'WaitingForServer', 'Scheduled', 'PickingPlayers');
CREATE INDEX IF NOT EXISTS idx_matches_active_lineup_2
    ON public.matches (lineup_2_id)
    WHERE status IN ('Live', 'Veto', 'WaitingForCheckIn', 'WaitingForServer', 'Scheduled', 'PickingPlayers');
CREATE INDEX IF NOT EXISTS idx_matches_active_organizer
    ON public.matches (organizer_steam_id)
    WHERE status IN ('Live', 'Veto', 'WaitingForCheckIn', 'WaitingForServer', 'Scheduled', 'PickingPlayers');
