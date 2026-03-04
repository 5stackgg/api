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
    auto_cancel_duration text;
    _track_cancellation boolean;
BEGIN
    auto_cancel_duration := get_setting('auto_cancel_duration', '15') || ' minutes';

    SELECT mo.track_cancellation INTO _track_cancellation
    FROM matches m
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    WHERE m.id = NEW.match_id;

    IF NEW.status = 'Warmup' THEN
        IF _track_cancellation THEN
            UPDATE matches SET cancels_at = NOW() + (auto_cancel_duration)::interval WHERE id = NEW.match_id;
        END IF;
    END IF;

    IF OLD.status != 'Paused' AND (NEW.status = 'Knife' OR NEW.status = 'Live' OR NEW.status = 'Overtime') THEN
        NEW.started_at = NOW();
        IF _track_cancellation THEN
            UPDATE matches SET cancels_at = NOW() + INTERVAL '3 hours' WHERE id = NEW.match_id;
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
