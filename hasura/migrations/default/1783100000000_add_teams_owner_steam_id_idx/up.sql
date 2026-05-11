CREATE INDEX IF NOT EXISTS idx_teams_owner_steam_id
  ON public.teams (owner_steam_id);
