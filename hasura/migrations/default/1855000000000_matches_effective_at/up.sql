ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS effective_at timestamptz
    GENERATED ALWAYS AS (COALESCE(started_at, scheduled_at, created_at)) STORED;

CREATE INDEX IF NOT EXISTS idx_matches_effective_at
  ON public.matches (effective_at DESC NULLS LAST, created_at DESC);

DROP FUNCTION IF EXISTS public.get_match_effective_at(public.matches);
