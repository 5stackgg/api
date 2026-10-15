DROP FUNCTION IF EXISTS public.chat_room_notifies(bigint, text, boolean);

DROP TABLE IF EXISTS public.chat_room_settings;

-- The boot loader skips a functions file whose digest is unchanged, so a
-- forward deploy after this rollback would bring the table back without it.
DO $$
BEGIN
  IF to_regclass('migration_hashes.hashes') IS NOT NULL THEN
    DELETE FROM migration_hashes.hashes
    WHERE replace(name, chr(92), '/') = 'hasura/functions/chat/chat_room_notifies';
  END IF;
END $$;
