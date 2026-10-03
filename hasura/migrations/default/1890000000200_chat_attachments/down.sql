DROP TRIGGER IF EXISTS tad_direct_messages ON public.direct_messages;
DROP FUNCTION IF EXISTS public.tad_direct_messages();

-- The boot step only re-applies a triggers file whose digest changed, so
-- forget this one or a later up would never recreate it.
DELETE FROM migration_hashes.hashes
 WHERE name = 'hasura/triggers/direct_messages';

ALTER TABLE public.direct_messages
    DROP COLUMN IF EXISTS attachments,
    DROP COLUMN IF EXISTS gif;

DROP TABLE IF EXISTS public.chat_attachments;

DELETE FROM public.settings
 WHERE name IN ('chat_attachment_max_mb', 'giphy_api_key');
