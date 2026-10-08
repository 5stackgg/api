-- 64Hz run-up ending at the release, t in ms (<= 0); null for a throw made standing still.
ALTER TABLE public.utility_lineups
    ADD COLUMN IF NOT EXISTS approach jsonb;
