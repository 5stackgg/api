-- The needs_rebuild flag flip is not cleanly reversible (prior per-season state
-- is unknown and a rebuild is idempotent), so only the notifications are removed.
DELETE FROM public.notifications
WHERE type = 'EloRecompute'
  AND title LIKE '%ELO rebuild required';
