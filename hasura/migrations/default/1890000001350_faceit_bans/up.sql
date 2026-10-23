ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS faceit_banned_at timestamptz,
  ADD COLUMN IF NOT EXISTS faceit_ban_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS faceit_bans_checked_at timestamptz;
