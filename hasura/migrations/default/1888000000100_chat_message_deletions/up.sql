CREATE TABLE IF NOT EXISTS public.chat_message_deletions (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    message_id uuid NOT NULL,
    room_type text NOT NULL,
    room_id text NOT NULL,
    author_steam_id bigint REFERENCES public.players (steam_id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    message text NOT NULL,
    message_created_at timestamptz,
    source text,
    deleted_by_steam_id bigint REFERENCES public.players (steam_id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    deleted_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (id),
    UNIQUE (room_type, room_id, message_id)
);

CREATE INDEX IF NOT EXISTS chat_message_deletions_author_idx
    ON public.chat_message_deletions (author_steam_id, deleted_at DESC);
