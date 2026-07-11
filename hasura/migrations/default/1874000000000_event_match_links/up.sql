-- Materialized event->match links. v_event_matches stays the single source
-- of truth for the derivation; triggers (hasura/triggers/event_match_links)
-- keep this table in sync so list queries paginate over an indexed table and
-- stats aggregate without re-deriving the windowed joins per query.
CREATE TABLE IF NOT EXISTS public.event_match_links (
    event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, match_id)
);
CREATE INDEX IF NOT EXISTS idx_event_match_links_match
    ON public.event_match_links(match_id);
