-- Matches not yet over. A subscription sends its own status filter as a run
-- time value, which Postgres re-reads on every row and cannot match to a
-- partial index, so filtering matches directly scans the whole table on every
-- poll. Rooted here, the statuses are constants, idx_matches_active holds just
-- these rows, and the subscription's filter only narrows them. Returning
-- matches rows keeps each role's matches permissions and computed fields.
CREATE OR REPLACE FUNCTION public.active_matches()
RETURNS SETOF public.matches
LANGUAGE sql
STABLE
AS $$
    SELECT *
    FROM matches
    WHERE status IN ('Live', 'Veto', 'WaitingForCheckIn', 'WaitingForServer', 'Scheduled', 'PickingPlayers')
$$;
