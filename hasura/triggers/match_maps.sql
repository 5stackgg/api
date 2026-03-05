CREATE OR REPLACE FUNCTION public.tau_match_maps() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM update_match_state(NEW);
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_match_maps ON public.match_maps;
CREATE TRIGGER tau_match_maps AFTER UPDATE ON public.match_maps FOR EACH ROW EXECUTE FUNCTION public.tau_match_maps();

CREATE OR REPLACE FUNCTION public.tbi_match_maps() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM check_match_map_count(NEW);
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_match_maps ON public.match_maps;
CREATE TRIGGER tbi_match_maps BEFORE INSERT ON public.match_maps FOR EACH ROW EXECUTE FUNCTION public.tbi_match_maps();


CREATE OR REPLACE FUNCTION public.tbu_match_maps() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _auto_cancel_duration text;
    _auto_cancellation boolean;
    _auto_cancel_duration_override integer;
    _live_match_timeout_override integer;
    _live_match_timeout text;
BEGIN
    SELECT mo.auto_cancellation, mo.auto_cancel_duration, mo.live_match_timeout
    INTO _auto_cancellation, _auto_cancel_duration_override, _live_match_timeout_override
    FROM matches m
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    WHERE m.id = NEW.match_id;

    _auto_cancel_duration := COALESCE(_auto_cancel_duration_override, get_setting('auto_cancel_duration', '15')::int)::text || ' minutes';
    _live_match_timeout := COALESCE(_live_match_timeout_override, get_setting('live_match_timeout', '180')::int)::text || ' minutes';

    IF NEW.status = 'Warmup' THEN
        IF _auto_cancellation THEN
            UPDATE matches SET cancels_at = NOW() + (_auto_cancel_duration)::interval WHERE id = NEW.match_id;
        END IF;
    END IF;

    IF NEW.status = 'Paused' AND OLD.status != 'Paused' THEN
        UPDATE matches SET cancels_at = NULL WHERE id = NEW.match_id;
    END IF;

    IF OLD.status = 'Paused' AND (NEW.status = 'Live' OR NEW.status = 'Overtime') THEN
        IF _auto_cancellation THEN
            UPDATE matches SET cancels_at = NOW() + (_live_match_timeout)::interval WHERE id = NEW.match_id;
        END IF;
    END IF;

    IF OLD.status != 'Paused' AND (NEW.status = 'Knife' OR NEW.status = 'Live' OR NEW.status = 'Overtime') THEN
        NEW.started_at = NOW();
        IF _auto_cancellation THEN
            UPDATE matches SET cancels_at = NOW() + (_live_match_timeout)::interval WHERE id = NEW.match_id;
        END IF;
    END IF;

    IF NEW.status = 'Finished' THEN
        NEW.ended_at = NOW();
    END IF;

	RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS tbu_match_maps ON public.match_maps;
CREATE TRIGGER tbu_match_maps BEFORE UPDATE ON public.match_maps FOR EACH ROW EXECUTE FUNCTION public.tbu_match_maps();
