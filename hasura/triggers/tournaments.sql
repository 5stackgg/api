CREATE OR REPLACE FUNCTION public.tau_tournaments() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN

    IF (NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'Live') THEN
        PERFORM seed_tournament(NEW);
    END IF;

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_tournaments ON public.tournaments;
CREATE TRIGGER tau_tournaments AFTER UPDATE ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.tau_tournaments();

CREATE OR REPLACE FUNCTION public.tad_tournaments() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM match_options
       WHERE id = OLD.match_options_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tad_tournaments ON public.tournaments;
CREATE TRIGGER tad_tournaments AFTER DELETE ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.tad_tournaments();
