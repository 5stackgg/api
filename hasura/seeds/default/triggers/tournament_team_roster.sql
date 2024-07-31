CREATE OR REPLACE FUNCTION public.taiud_tournament_team_roster() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM check_team_eligibility(NEW);
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS taiud_tournament_team_roster ON public.tournament_team_roster;
CREATE TRIGGER taiud_tournament_team_roster AFTER INSERT OR UPDATE OR DELETE ON public.tournament_team_roster FOR EACH ROW EXECUTE FUNCTION public.taiud_tournament_team_roster();