-- Set when a group room's message is deleted: the file is kept as evidence,
-- for staff only, until it expires.
ALTER TABLE public.chat_attachments
    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- What a player uploaded, kept apart from the files so removing a file does
-- not give its bytes back to the daily allowance.
CREATE TABLE IF NOT EXISTS public.chat_attachment_usage (
    id bigserial PRIMARY KEY,
    steam_id bigint NOT NULL REFERENCES public.players (steam_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    bytes bigint NOT NULL CHECK (bytes > 0),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_attachment_usage_steam_id_created_at_idx
    ON public.chat_attachment_usage (steam_id, created_at);

CREATE INDEX IF NOT EXISTS chat_attachment_usage_created_at_idx
    ON public.chat_attachment_usage (created_at);

ALTER TABLE public.chat_message_deletions
    ADD COLUMN IF NOT EXISTS attachments jsonb,
    ADD COLUMN IF NOT EXISTS gif jsonb;
