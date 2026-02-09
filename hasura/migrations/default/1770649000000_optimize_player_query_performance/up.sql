CREATE INDEX IF NOT EXISTS idx_matches_created_winning_lineups
ON matches(created_at DESC, winning_lineup_id)
INCLUDE (lineup_1_id, lineup_2_id, match_options_id, status);

CREATE INDEX IF NOT EXISTS idx_matches_organizer_lineups
ON matches(organizer_steam_id, lineup_1_id, lineup_2_id)
WHERE winning_lineup_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_match_options_id_lobby_access
ON match_options(id, lobby_access)
INCLUDE (type);

CREATE INDEX IF NOT EXISTS idx_matches_finished
ON matches(created_at DESC, id)
INCLUDE (lineup_1_id, lineup_2_id, match_options_id, status, organizer_steam_id)
WHERE winning_lineup_id IS NOT NULL;
