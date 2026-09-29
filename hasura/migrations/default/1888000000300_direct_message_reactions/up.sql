CREATE TABLE IF NOT EXISTS public.direct_message_reactions (
    message_id uuid NOT NULL REFERENCES public.direct_messages (id)
        ON DELETE CASCADE,
    steam_id bigint NOT NULL REFERENCES public.players (steam_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    reaction text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (message_id, steam_id, reaction)
);

CREATE INDEX IF NOT EXISTS direct_message_reactions_steam_id_idx
    ON public.direct_message_reactions (steam_id);
