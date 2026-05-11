ALTER TABLE public.match_lineups
  ADD COLUMN IF NOT EXISTS match_id uuid;

UPDATE public.match_lineups ml
   SET match_id = m.id
  FROM public.matches m
 WHERE (m.lineup_1_id = ml.id OR m.lineup_2_id = ml.id)
   AND ml.match_id IS NULL;

ALTER TABLE public.match_lineups
  DROP CONSTRAINT IF EXISTS match_lineups_match_id_fkey;
ALTER TABLE public.match_lineups
  ADD CONSTRAINT match_lineups_match_id_fkey
  FOREIGN KEY (match_id) REFERENCES public.matches(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_match_lineups_match_id
  ON public.match_lineups (match_id);
