ALTER TABLE public.tournaments
    ADD COLUMN IF NOT EXISTS regions text[] NOT NULL DEFAULT '{}';
