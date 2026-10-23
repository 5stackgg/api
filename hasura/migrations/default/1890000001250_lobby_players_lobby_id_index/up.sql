-- The key leads with steam_id, so finding a lobby's players read the whole
-- index; the friends list does that for every friend in a lobby.
CREATE INDEX IF NOT EXISTS idx_lobby_players_lobby_id ON public.lobby_players (lobby_id);
