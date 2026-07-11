-- Event lifecycle is derived from starts_at/ends_at and hiding is handled by
-- the visibility column (Private/Friends/Public), so the status machine is
-- redundant. get_event_leaderboard referenced e.status and is re-applied in
-- the functions boot phase (its file changed in the same release); nothing
-- else reads the column.
ALTER TABLE public.events DROP COLUMN IF EXISTS status;
DROP TABLE IF EXISTS public.e_event_status;
