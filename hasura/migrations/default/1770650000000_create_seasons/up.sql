CREATE TABLE public.seasons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    number INT,
    description TEXT,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.seasons
    ADD CONSTRAINT seasons_no_overlap
    EXCLUDE USING gist (tstzrange(starts_at, ends_at, '[)') WITH &&);

ALTER TABLE public.player_elo ADD COLUMN season_id UUID REFERENCES public.seasons(id);
CREATE INDEX idx_player_elo_season ON public.player_elo (steam_id, type, season_id, created_at DESC);
CREATE INDEX idx_player_elo_season_board ON public.player_elo (season_id, type, steam_id, created_at DESC);

CREATE TABLE public.player_season_stats (
    player_steam_id BIGINT NOT NULL REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
    season_id UUID NOT NULL REFERENCES public.seasons(id) ON UPDATE CASCADE ON DELETE CASCADE,
    kills BIGINT NOT NULL DEFAULT 0,
    deaths BIGINT NOT NULL DEFAULT 0,
    assists BIGINT NOT NULL DEFAULT 0,
    headshots BIGINT NOT NULL DEFAULT 0,
    headshot_percentage FLOAT NOT NULL DEFAULT 0,
    PRIMARY KEY (player_steam_id, season_id)
);

INSERT INTO public.settings (name, value)
VALUES ('public.seasons_enabled', 'false')
ON CONFLICT (name) DO NOTHING;
