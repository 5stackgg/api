-- get_event_leaderboard's pre-1872 file version references e.status; drop it
-- and clear its boot digest so the next boot of the older release re-applies
-- its own version cleanly (see 1867000000300_events/down.sql for the pattern).
DROP FUNCTION IF EXISTS public.get_event_leaderboard(UUID, TEXT, TEXT, INT, JSON);
DROP FUNCTION IF EXISTS public.get_event_leaderboard(UUID, TEXT, TEXT, INT);
DO $$
BEGIN
  IF to_regclass('migration_hashes.hashes') IS NOT NULL THEN
    DELETE FROM migration_hashes.hashes
    WHERE name = 'hasura/functions/events/get_event_leaderboard';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.e_event_status (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);

INSERT INTO public.e_event_status (value, description) VALUES
    ('Setup', 'Event is being set up; hidden from the public'),
    ('Live', 'Event is in progress'),
    ('Finished', 'Event has finished')
ON CONFLICT (value) DO NOTHING;

-- Backfill existing rows as Live (visible) rather than the original Setup
-- default, so a rollback does not hide every event on the instance; new rows
-- then get the original Setup default.
ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'Live'
        REFERENCES public.e_event_status(value);
ALTER TABLE public.events ALTER COLUMN status SET DEFAULT 'Setup';
