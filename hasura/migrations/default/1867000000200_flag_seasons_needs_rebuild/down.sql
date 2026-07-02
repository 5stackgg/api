-- The needs_rebuild flag flip is not cleanly reversible (prior per-season state
-- is unknown and a rebuild is idempotent), so only the notification is removed.
DELETE FROM public.notifications
WHERE type = 'EloRecompute'
  AND title = 'Season ELO rebuild required';
