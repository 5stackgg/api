CREATE TABLE IF NOT EXISTS public.chat_room_settings (
    steam_id bigint NOT NULL
        REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
    thread text NOT NULL
        CONSTRAINT chat_room_settings_thread
        CHECK (thread ~ '^chat:[a-z_]+:\S+$' AND char_length(thread) <= 200),
    muted boolean NOT NULL DEFAULT false,
    muted_until timestamptz
        CONSTRAINT chat_room_settings_muted_until
        CHECK (muted OR muted_until IS NULL),
    notify text NOT NULL DEFAULT 'all'
        CONSTRAINT chat_room_settings_notify
        CHECK (notify IN ('all', 'mentions', 'nothing')),
    PRIMARY KEY (steam_id, thread)
);
