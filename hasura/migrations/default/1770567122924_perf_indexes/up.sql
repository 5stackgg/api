CREATE INDEX IF NOT EXISTS idx_player_elo_steam_id_type_created_at
  ON player_elo(steam_id, type, created_at DESC);
  
CREATE INDEX IF NOT EXISTS idx_match_lineup_players_steam_id_lineup_id
  ON match_lineup_players(steam_id, match_lineup_id);

-- Partial index for active matches only
CREATE INDEX IF NOT EXISTS idx_matches_status_lineup
  ON matches(status, lineup_1_id, lineup_2_id)
  WHERE status IN ('Live', 'Veto');

CREATE INDEX IF NOT EXISTS idx_match_options_id_type
  ON match_options(id) INCLUDE (type);

CREATE INDEX IF NOT EXISTS idx_matches_lineup_ids 
ON matches(lineup_1_id, lineup_2_id) 
INCLUDE (id, match_options_id, winning_lineup_id, created_at);

CREATE INDEX IF NOT EXISTS idx_matches_match_options_id 
ON matches(match_options_id);