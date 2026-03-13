ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS discord_guild_id text,
  ADD COLUMN IF NOT EXISTS discord_voice_enabled boolean NOT NULL DEFAULT false;
