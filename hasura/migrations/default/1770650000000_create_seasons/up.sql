-- Create seasons table
CREATE TABLE public.seasons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ,  -- NULL = currently active
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one active season at a time
CREATE UNIQUE INDEX idx_seasons_one_active ON public.seasons ((1)) WHERE ends_at IS NULL;

-- Add season_id to player_elo
ALTER TABLE public.player_elo ADD COLUMN season_id UUID REFERENCES public.seasons(id);

-- Index for efficient season-scoped ELO lookups
CREATE INDEX idx_player_elo_season ON public.player_elo (steam_id, type, season_id, created_at DESC);

-- Create player_season_stats table
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

-- Helper function to get the current active season
CREATE OR REPLACE FUNCTION public.get_active_season() RETURNS UUID
    LANGUAGE sql STABLE
    AS $$ SELECT id FROM seasons WHERE ends_at IS NULL LIMIT 1; $$;
