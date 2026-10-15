DROP TRIGGER IF EXISTS tbiu_chat_room_settings ON public.chat_room_settings;
DROP FUNCTION IF EXISTS public.tbiu_chat_room_settings();

ALTER TABLE public.chat_room_settings
    DROP CONSTRAINT IF EXISTS chat_room_settings_mute_minutes;

ALTER TABLE public.chat_room_settings
    DROP COLUMN IF EXISTS mute_minutes;

-- The boot loader skips a triggers file whose digest is unchanged, so a
-- forward deploy after this rollback would bring the column back without it.
DO $$
BEGIN
  IF to_regclass('migration_hashes.hashes') IS NOT NULL THEN
    DELETE FROM migration_hashes.hashes
    WHERE replace(name, chr(92), '/') = 'hasura/triggers/chat_room_settings';
  END IF;
END $$;
