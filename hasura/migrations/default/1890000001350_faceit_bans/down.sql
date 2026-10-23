ALTER TABLE public.players
  DROP COLUMN IF EXISTS faceit_bans_checked_at,
  DROP COLUMN IF EXISTS faceit_ban_ends_at,
  DROP COLUMN IF EXISTS faceit_banned_at;
