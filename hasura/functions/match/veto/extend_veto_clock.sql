CREATE OR REPLACE FUNCTION public.extend_veto_clock(_match_id uuid, _seconds int) RETURNS timestamptz
    LANGUAGE plpgsql
    AS $$
DECLARE
    _expires_at timestamptz;
BEGIN
    IF _seconds IS NULL OR _seconds < 1 OR _seconds > 600 THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Add between 1 and 600 seconds';
    END IF;

    UPDATE matches
    SET veto_pick_expires_at = GREATEST(veto_pick_expires_at, NOW()) + make_interval(secs => _seconds)
    WHERE id = _match_id
      AND status = 'Veto'
      AND veto_pick_expires_at IS NOT NULL
    RETURNING veto_pick_expires_at INTO _expires_at;

    IF _expires_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'The veto clock is not running';
    END IF;

    PERFORM push_back_veto_auto_cancel(_match_id);

    RETURN _expires_at;
END;
$$;
