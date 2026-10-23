-- The newest game ban gets its own date, kept the same way as
-- last_vac_ban_at, so each kind of Steam ban can be dated on its own.
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS last_game_ban_at timestamptz;

UPDATE public.players
   SET last_game_ban_at = COALESCE(steam_bans_checked_at, now())
                          - make_interval(days => COALESCE(days_since_last_ban, 0))
 WHERE game_ban_count > 0
   AND last_game_ban_at IS NULL;

ALTER TABLE public.recent_ban_entries
  ADD COLUMN IF NOT EXISTS vac_banned_on date,
  ADD COLUMN IF NOT EXISTS game_banned_on date;
