CREATE OR REPLACE FUNCTION public.tau_match_maps() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM update_match_state(NEW);
    PERFORM check_match_map_count(NEW);
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
CREATE TRIGGER tbi_match_maps BEFORE INSERT OR UPDATE ON public.match_maps FOR EACH ROW EXECUTE FUNCTION public.tbi_match_maps();