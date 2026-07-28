ALTER TABLE public.pending_match_imports
    ADD COLUMN IF NOT EXISTS parties jsonb;
