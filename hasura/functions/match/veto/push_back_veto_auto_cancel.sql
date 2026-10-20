-- Auto-cancel is armed once, on entering Veto. Redoing steps or adding time
-- late in the veto must not let it run out mid-veto, so both give the match a
-- fresh window from now when that is later than the one it has.
CREATE OR REPLACE FUNCTION public.push_back_veto_auto_cancel(_match_id uuid) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    _auto_cancellation boolean;
    _auto_cancel_duration int;
BEGIN
    SELECT auto_cancellation, auto_cancel_duration
    INTO _auto_cancellation, _auto_cancel_duration
    FROM resolve_match_auto_cancel(_match_id);

    IF NOT COALESCE(_auto_cancellation, false) THEN
        RETURN;
    END IF;

    UPDATE matches
    SET cancels_at = GREATEST(
        COALESCE(cancels_at, NOW()),
        NOW() + (COALESCE(_auto_cancel_duration, get_int_setting('auto_cancel_duration', 15))::text || ' minutes')::interval
    )
    WHERE id = _match_id AND status = 'Veto';
END;
$$;
