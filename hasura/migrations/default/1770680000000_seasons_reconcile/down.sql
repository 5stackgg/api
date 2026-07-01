DROP TRIGGER IF EXISTS tbi_seasons_mark_rebuild ON public.seasons;
DROP FUNCTION IF EXISTS public.tbi_seasons_mark_rebuild();
DROP TRIGGER IF EXISTS tai_seasons_reconcile ON public.seasons;
DROP FUNCTION IF EXISTS public.tai_seasons_reconcile();
ALTER TABLE public.seasons DROP COLUMN IF EXISTS needs_rebuild;
