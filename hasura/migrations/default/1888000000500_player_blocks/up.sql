CREATE TABLE IF NOT EXISTS public.player_blocks (
    blocker_steam_id bigint NOT NULL REFERENCES public.players (steam_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    blocked_steam_id bigint NOT NULL REFERENCES public.players (steam_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (blocker_steam_id, blocked_steam_id),

    CONSTRAINT player_blocks_not_self
        CHECK (blocker_steam_id <> blocked_steam_id)
);

CREATE INDEX IF NOT EXISTS player_blocks_blocked_steam_id_idx
    ON public.player_blocks (blocked_steam_id, blocker_steam_id);
