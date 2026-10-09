-- The render pipeline's version that filmed a lineup's preview, as the
-- director reported it. NULL on a lineup with a preview is one filmed before
-- previews were versioned; 0 is one filmed since, by a director that did not
-- say. Either way nobody knows what filmed it, which makes it outdated.
ALTER TABLE public.utility_lineups
    ADD COLUMN IF NOT EXISTS preview_version integer;

ALTER TABLE public.utility_lineup_renders
    ADD COLUMN IF NOT EXISTS render_version integer;

-- One render pod films the whole queue on one practice session, so the pod is
-- a fact about the session: which k8s Job it is, and when it last asked what
-- to film next. Kept here rather than read off the session's render rows,
-- which are deleted as lineups are re-rendered and the queue is cleared.
ALTER TABLE public.utility_practice_sessions
    ADD COLUMN IF NOT EXISTS render_job_name text,
    ADD COLUMN IF NOT EXISTS render_seen_at timestamptz;
