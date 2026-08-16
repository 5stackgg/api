-- How long until this player's quiet window is over, in seconds. 0 when they
-- are not in one.
--
-- Quiet hours used to drop a push outright. Nothing was lost -- the bell row is
-- written either way -- but a night of messages arrived as nothing at all, and
-- the player woke up to a silent phone and a full bell. This is what lets the
-- push be held instead and delivered as one summary when the window closes.
CREATE OR REPLACE FUNCTION public.quiet_hours_seconds_remaining(
    _start time,
    _end time,
    _timezone text
) RETURNS integer
-- STABLE for the same reason is_quiet_hours is: the answer depends on now(),
-- and folding it at plan time would keep returning a stale figure.
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _local time;
    _seconds integer;
BEGIN
    IF NOT public.is_quiet_hours(_start, _end, _timezone) THEN
        RETURN 0;
    END IF;

    BEGIN
        _local := (now() AT TIME ZONE COALESCE(_timezone, 'UTC'))::time;
    EXCEPTION WHEN OTHERS THEN
        _local := (now() AT TIME ZONE 'UTC')::time;
    END;

    _seconds := EXTRACT(EPOCH FROM (_end - _local))::integer;

    -- A window that wraps midnight (22:00 -> 07:00) puts the end earlier in the
    -- day than now, so the difference comes back negative and the wait is
    -- actually to that time tomorrow.
    IF _seconds <= 0 THEN
        _seconds := _seconds + 86400;
    END IF;

    RETURN _seconds;
END;
$$;
