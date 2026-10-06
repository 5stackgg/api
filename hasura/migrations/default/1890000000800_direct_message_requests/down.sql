ALTER TABLE public.direct_conversations
    DROP COLUMN IF EXISTS declined_at,
    DROP COLUMN IF EXISTS accepted_at;

-- v_my_friends selects p.*, so it holds the column; it is recreated from
-- hasura/views on the next boot once its digest is forgotten below.
DROP VIEW IF EXISTS public.v_my_friends;

ALTER TABLE public.players
    DROP COLUMN IF EXISTS allow_message_requests;

DROP FUNCTION IF EXISTS public.direct_message_refusal(text, bigint);
DROP FUNCTION IF EXISTS public.can_view_direct_room(text, bigint);
DROP FUNCTION IF EXISTS public.are_friends(bigint, bigint);

DO $$
BEGIN
  IF to_regclass('migration_hashes.hashes') IS NOT NULL THEN
    DELETE FROM migration_hashes.hashes
    WHERE name IN ('hasura/functions/chat/direct_message_access',
                   'hasura/views/v_my_friends');
  END IF;
END $$;
