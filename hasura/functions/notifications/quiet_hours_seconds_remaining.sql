-- Seconds until this player's quiet window is over; 0 when they are not in one.
-- Lets a push be held and delivered as one summary rather than dropped.
CREATE OR REPLACE FUNCTION public.quiet_hours_seconds_remaining(
    _start time,
    _end time,
    _timezone text
) RETURNS integer
-- STABLE, like is_quiet_hours: the answer depends on now().
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _local time;
    _seconds numeric;
BEGIN
    IF NOT public.is_quiet_hours(_start, _end, _timezone) THEN
        RETURN 0;
    END IF;

    BEGIN
        _local := (now() AT TIME ZONE COALESCE(_timezone, 'UTC'))::time;
    EXCEPTION WHEN OTHERS THEN
        _local := (now() AT TIME ZONE 'UTC')::time;
    END;

    -- Unrounded: truncating turns the last fraction of a second before the
    -- window closes into 0, which the wrap below then reads as a full day.
    _seconds := EXTRACT(EPOCH FROM (_end - _local));

    -- A window that wraps midnight (22:00 -> 07:00) ends earlier in the day
    -- than now, so the wait is to that time tomorrow.
    IF _seconds <= 0 THEN
        _seconds := _seconds + 86400;
    END IF;

    RETURN GREATEST(ceil(_seconds), 1)::integer;
END;
$$;
