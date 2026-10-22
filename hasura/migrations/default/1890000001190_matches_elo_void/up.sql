ALTER TABLE public.matches
    ADD COLUMN IF NOT EXISTS elo_voided boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS elo_voided_at timestamptz NULL,
    ADD COLUMN IF NOT EXISTS elo_voided_by_steam_id bigint NULL
        REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE SET NULL;

-- The ratings that skip voided matches probe for them on every player_elo row.
CREATE INDEX IF NOT EXISTS idx_matches_elo_voided
    ON public.matches (id)
    WHERE elo_voided;
