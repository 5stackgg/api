CREATE OR REPLACE FUNCTION public.taiu_tournament_stages() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM update_tournament_stages(NEW.tournament_id);
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS taiu_tournament_stages ON public.tournament_stages;
CREATE TRIGGER taiu_tournament_stages AFTER INSERT OR UPDATE ON public.tournament_stages FOR EACH ROW EXECUTE FUNCTION public.taiu_tournament_stages();
