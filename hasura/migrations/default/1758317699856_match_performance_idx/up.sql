CREATE INDEX IF NOT EXISTS idx_match_lineup_players_steam_id ON match_lineup_players(steam_id);
CREATE INDEX IF NOT EXISTS idx_matches_lineup_1_id ON matches(lineup_1_id);
CREATE INDEX IF NOT EXISTS idx_matches_lineup_2_id ON matches(lineup_2_id);
CREATE INDEX IF NOT EXISTS idx_player_elo_steam_id_created_at ON player_elo(steam_id, created_at DESC);