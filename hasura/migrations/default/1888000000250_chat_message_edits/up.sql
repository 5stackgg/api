CREATE TABLE IF NOT EXISTS public.chat_message_edits (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    message_id uuid NOT NULL,
    room_type text NOT NULL,
    room_id text NOT NULL,
    author_steam_id bigint REFERENCES public.players (steam_id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    previous_message text NOT NULL,
    new_message text NOT NULL,
    message_created_at timestamptz,
    edited_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS chat_message_edits_message_id_idx
    ON public.chat_message_edits (message_id);

CREATE INDEX IF NOT EXISTS chat_message_edits_author_idx
    ON public.chat_message_edits (author_steam_id, edited_at DESC);
