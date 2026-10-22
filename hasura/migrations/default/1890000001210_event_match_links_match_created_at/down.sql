DROP TRIGGER IF EXISTS tbi_event_match_links_match_created_at ON public.event_match_links;
DROP FUNCTION IF EXISTS public.tbi_event_match_links_match_created_at();
DROP INDEX IF EXISTS public.event_match_links_event_match_created_at_idx;
ALTER TABLE public.event_match_links DROP COLUMN IF EXISTS match_created_at;
