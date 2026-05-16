CREATE TABLE IF NOT EXISTS player_leaderboard_rank (
  player_steam_id TEXT NOT NULL,
  value FLOAT NOT NULL DEFAULT 0,
  rank INT NOT NULL DEFAULT 0,
  total INT NOT NULL DEFAULT 0
);
