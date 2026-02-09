CREATE INDEX IF NOT EXISTS idx_player_kills_match_attacker
ON public.player_kills (match_id, attacker_steam_id);

CREATE INDEX IF NOT EXISTS idx_player_kills_match_attacked
ON public.player_kills (match_id, attacked_steam_id);

CREATE INDEX IF NOT EXISTS idx_player_assists_match_attacker
ON public.player_assists (match_id, attacker_steam_id);

CREATE INDEX IF NOT EXISTS idx_player_elo_steam_type_created_match
ON public.player_elo (steam_id, type, created_at DESC, match_id)
INCLUDE (current);