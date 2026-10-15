-- Veto scouting reads a lineup's past picks: a team's recent vetoes, and the
-- vetoes a player ran as a pickup captain. Both reach match_map_veto_picks
-- through match_lineup_id, which had no index, so each read scanned every pick.
CREATE INDEX IF NOT EXISTS idx_match_map_veto_picks_match_lineup_id
  ON public.match_map_veto_picks (match_lineup_id);
