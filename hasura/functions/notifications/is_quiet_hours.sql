-- True when the player's local time falls inside their quiet window.
--
-- Gates PUSH only. The bell keeps collecting, so nothing is lost -- quiet hours
-- silence the buzz, they don't drop the notification.
CREATE OR REPLACE FUNCTION public.is_quiet_hours(
    _start time,
    _end time,
    _timezone text
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    _local time;
BEGIN
    -- Unset, or a zero-width window, means quiet hours are off.
    IF _start IS NULL OR _end IS NULL OR _start = _end THEN
        RETURN false;
    END IF;

    BEGIN
        _local := (now() AT TIME ZONE COALESCE(_timezone, 'UTC'))::time;
    EXCEPTION WHEN OTHERS THEN
        -- An unrecognised zone would otherwise raise and take the whole
        -- recipient query with it, silencing everyone rather than nobody.
        _local := (now() AT TIME ZONE 'UTC')::time;
    END;

    -- A window that wraps midnight (22:00 -> 07:00) is the common case, so it
    -- gets its own branch rather than being handled by accident.
    IF _start < _end THEN
        RETURN _local >= _start AND _local < _end;
    END IF;

    RETURN _local >= _start OR _local < _end;
END;
$$;
