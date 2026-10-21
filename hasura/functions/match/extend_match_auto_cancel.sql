CREATE OR REPLACE FUNCTION public.extend_match_auto_cancel(_match_id uuid, _minutes int) RETURNS timestamptz
    LANGUAGE plpgsql
    AS $$
DECLARE
    _cancels_at timestamptz;
BEGIN
    IF _minutes IS NULL OR _minutes < 1 OR _minutes > 120 THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Add between 1 and 120 minutes';
    END IF;

    -- A passed deadline stays passed: CancelExpiredMatches may already be
    -- canceling or forfeiting the match, and would not see the new one.
    UPDATE matches
    SET cancels_at = cancels_at + make_interval(mins => _minutes)
    WHERE id = _match_id
      AND status NOT IN ('Canceled', 'Finished', 'Forfeit', 'Tie', 'Surrendered')
      AND cancels_at > NOW()
    RETURNING cancels_at INTO _cancels_at;

    IF _cancels_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'The match has no deadline left to push back';
    END IF;

    RETURN _cancels_at;
END;
$$;
