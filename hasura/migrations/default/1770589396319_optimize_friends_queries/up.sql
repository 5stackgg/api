CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_friends_other_player_steam_id
  ON friends(other_player_steam_id, player_steam_id);