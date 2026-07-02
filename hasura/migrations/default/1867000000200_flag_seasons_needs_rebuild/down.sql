-- The needs_rebuild flag flip is not cleanly reversible (prior per-season state
-- is unknown and a rebuild is idempotent), so this migration has no meaningful
-- down step.
SELECT 1;
