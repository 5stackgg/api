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
BEGIN
    IF NEW.status = 'Warmup' THEN
        update matches set cancels_at = NOW() + INTERVAL '15 minutes' where id = NEW.match_id;
    END IF;

    IF NEW.status = 'Live' THEN
        NEW.started_at = NOW();
        update matches set cancels_at = null where id = NEW.match_id;
    END IF;

    IF NEW.status = 'Finished' THEN
        NEW.ended_at = NOW();

        NEW.winning_lineup_id = get_match_map_winning_lineup_id(NEW);
    END IF;

	RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS tbu_match_maps ON public.match_maps;
CREATE TRIGGER tbu_match_maps BEFORE UPDATE ON public.match_maps FOR EACH ROW EXECUTE FUNCTION public.tbu_match_maps();
