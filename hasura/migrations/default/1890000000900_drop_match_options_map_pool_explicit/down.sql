ALTER TABLE public.match_options
    ADD COLUMN IF NOT EXISTS map_pool_explicit boolean NOT NULL DEFAULT false;
