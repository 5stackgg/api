-- The deadline reconcile and CancelExpiredMatches both look matches up by
-- cancels_at, which only a small share of rows ever has set.
CREATE INDEX IF NOT EXISTS idx_matches_cancels_at
    ON public.matches (cancels_at)
    WHERE cancels_at IS NOT NULL;
