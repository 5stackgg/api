ALTER TABLE public.tournaments
    ADD COLUMN IF NOT EXISTS auto_start boolean NOT NULL DEFAULT true;
