ALTER TABLE public.recent_ban_entries
  DROP COLUMN IF EXISTS game_banned_on,
  DROP COLUMN IF EXISTS vac_banned_on;

ALTER TABLE public.players
  DROP COLUMN IF EXISTS last_game_ban_at;
