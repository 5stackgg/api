-- Type-definition table for Hasura-tracked leaderboard function.
-- Never written to directly; only used as the SETOF return type.
CREATE TABLE IF NOT EXISTS leaderboard_entries (
  player_steam_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  player_avatar_url TEXT,
  player_country TEXT,
  value FLOAT NOT NULL DEFAULT 0,
  secondary_value FLOAT,
  tertiary_value FLOAT,
  matches_played INT DEFAULT 0
);

-- Missing index for time-window queries on matches.ended_at
CREATE INDEX IF NOT EXISTS idx_matches_ended_at
  ON matches(ended_at DESC)
  WHERE ended_at IS NOT NULL;
