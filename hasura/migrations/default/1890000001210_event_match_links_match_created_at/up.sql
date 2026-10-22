-- An event's matches page sorts on its matches' creation time. Sorting through
-- the match relationship kept Hasura from applying the page LIMIT until every
-- match in the event had been built, so the link carries the time itself.
ALTER TABLE public.event_match_links ADD COLUMN IF NOT EXISTS match_created_at timestamptz;

UPDATE public.event_match_links l
SET match_created_at = m.created_at
FROM public.matches m
WHERE m.id = l.match_id;

CREATE INDEX IF NOT EXISTS event_match_links_event_match_created_at_idx
    ON public.event_match_links (event_id, match_created_at DESC);
