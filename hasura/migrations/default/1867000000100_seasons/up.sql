-- Seasons (consolidated). Idempotent so it applies cleanly on a fresh database
-- and on ones that already ran the earlier per-step seasons migrations.

CREATE TABLE IF NOT EXISTS public.seasons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    number INT,
    description TEXT,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    needs_rebuild BOOLEAN NOT NULL DEFAULT false
);

ALTER TABLE public.seasons ADD COLUMN IF NOT EXISTS number INT;
ALTER TABLE public.seasons ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE public.seasons ADD COLUMN IF NOT EXISTS needs_rebuild BOOLEAN NOT NULL DEFAULT false;

WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY starts_at ASC) AS rn FROM public.seasons
)
UPDATE public.seasons s SET number = r.rn
FROM ranked r WHERE s.id = r.id AND s.number IS DISTINCT FROM r.rn;
ALTER TABLE public.seasons ALTER COLUMN number SET NOT NULL;

DROP INDEX IF EXISTS public.idx_seasons_one_active;
ALTER TABLE public.seasons DROP CONSTRAINT IF EXISTS seasons_no_overlap;
ALTER TABLE public.seasons
    ADD CONSTRAINT seasons_no_overlap
    EXCLUDE USING gist (tstzrange(starts_at, ends_at, '[)') WITH &&);

-- Season-scoped ELO. Deleting a season SET NULLs these (ELO history is kept).
ALTER TABLE public.player_elo ADD COLUMN IF NOT EXISTS season_id UUID;
ALTER TABLE public.player_elo DROP CONSTRAINT IF EXISTS player_elo_season_id_fkey;
ALTER TABLE public.player_elo
    ADD CONSTRAINT player_elo_season_id_fkey
    FOREIGN KEY (season_id) REFERENCES public.seasons(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_player_elo_season
    ON public.player_elo (steam_id, type, season_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_player_elo_season_board
    ON public.player_elo (season_id, type, steam_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.player_season_stats (
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
