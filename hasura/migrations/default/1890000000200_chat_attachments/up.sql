CREATE TABLE IF NOT EXISTS public.chat_attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Kept when the player goes: the row is what the file is swept by.
    uploader_steam_id bigint REFERENCES public.players (steam_id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    room_type text NOT NULL,
    room_id text NOT NULL,
    storage_prefix text NOT NULL,
    file_name text NOT NULL,
    mime_type text NOT NULL,
    size bigint NOT NULL CHECK (size > 0),
    width integer,
    height integer,
    duration_ms integer,
    poster_mime_type text,
    -- Set until the multipart upload completes.
    upload_id text,
    uploaded_at timestamptz,
    message_id uuid,
    sent_at timestamptz,
    -- NULL only for a sent direct message's file, which goes with its message.
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_attachments_expires_at_idx
    ON public.chat_attachments (expires_at)
    WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS chat_attachments_message_id_idx
    ON public.chat_attachments (message_id)
    WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS chat_attachments_pending_idx
    ON public.chat_attachments (uploader_steam_id)
    WHERE message_id IS NULL;

CREATE INDEX IF NOT EXISTS chat_attachments_room_idx
    ON public.chat_attachments (room_type, room_id);

CREATE INDEX IF NOT EXISTS chat_attachments_storage_prefix_idx
    ON public.chat_attachments (storage_prefix text_pattern_ops);

ALTER TABLE public.direct_messages
    ADD COLUMN IF NOT EXISTS attachments jsonb,
    ADD COLUMN IF NOT EXISTS gif jsonb;
