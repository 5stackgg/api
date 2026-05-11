CREATE INDEX IF NOT EXISTS idx_player_sanctions_steam_type
  ON public.player_sanctions (player_steam_id, type);
