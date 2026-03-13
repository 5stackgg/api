ALTER TABLE public.tournaments
  DROP COLUMN IF EXISTS discord_guild_id,
  DROP COLUMN IF EXISTS discord_voice_enabled;
