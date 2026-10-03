ALTER TABLE public.chat_message_deletions
    DROP COLUMN IF EXISTS attachments,
    DROP COLUMN IF EXISTS gif;

DROP TABLE IF EXISTS public.chat_attachment_usage;

ALTER TABLE public.chat_attachments
    DROP COLUMN IF EXISTS deleted_at;

DELETE FROM public.settings
 WHERE name IN ('chat_attachment_daily_mb', 'giphy_hourly_limit');
