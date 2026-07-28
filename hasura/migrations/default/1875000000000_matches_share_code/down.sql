DROP INDEX IF EXISTS public.idx_matches_share_code;

ALTER TABLE public.matches
    DROP COLUMN IF EXISTS share_code;
