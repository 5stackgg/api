DROP INDEX IF EXISTS public.idx_match_lineups_match_id;

ALTER TABLE public.match_lineups
  DROP CONSTRAINT IF EXISTS match_lineups_match_id_fkey;

ALTER TABLE public.match_lineups
  DROP COLUMN IF EXISTS match_id;
