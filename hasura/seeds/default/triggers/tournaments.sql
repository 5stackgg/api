CREATE OR REPLACE FUNCTION public.tau_tournaments() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN

    IF (NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'Live') THEN
        PERFORM seed_tournament(NEW);
    END IF;

    IF NEW.status = 'Live' THEN
        PERFORM update_tournament_stages(NEW.id);
    END IF;

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_tournaments ON public.tournaments;
CREATE TRIGGER tau_tournaments AFTER UPDATE ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.tau_tournaments();
