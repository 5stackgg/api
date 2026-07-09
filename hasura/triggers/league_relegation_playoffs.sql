CREATE OR REPLACE FUNCTION public.tau_league_relegation_playoff() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.status = 'Finished' AND OLD.status IS DISTINCT FROM 'Finished'
       AND EXISTS (SELECT 1 FROM public.league_relegation_playoffs WHERE tournament_id = NEW.id) THEN
        PERFORM public.resolve_league_relegation_playoff(NEW.id);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_league_relegation_playoff ON public.tournaments;
CREATE TRIGGER tau_league_relegation_playoff
    AFTER UPDATE ON public.tournaments
    FOR EACH ROW
    EXECUTE FUNCTION public.tau_league_relegation_playoff();
