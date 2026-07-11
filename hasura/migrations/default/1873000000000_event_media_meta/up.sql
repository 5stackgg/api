ALTER TABLE public.event_media
    ADD COLUMN IF NOT EXISTS title text;

-- Media items can tag the players featured in them.
CREATE TABLE IF NOT EXISTS public.event_media_players (
    media_id uuid NOT NULL REFERENCES public.event_media(id) ON DELETE CASCADE,
    steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (media_id, steam_id)
);
CREATE INDEX IF NOT EXISTS idx_event_media_players_steam
    ON public.event_media_players(steam_id);
