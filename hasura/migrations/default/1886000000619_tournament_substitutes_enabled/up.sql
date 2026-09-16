ALTER TABLE public.tournaments
    ADD COLUMN IF NOT EXISTS substitutes_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.tournaments.substitutes_enabled IS 'Whether teams may roster and field substitutes beyond the starting lineup';
