CREATE OR REPLACE FUNCTION public.tai_teams() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM add_owner_to_team(NEW);
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_teams ON public.teams;
CREATE TRIGGER tai_teams AFTER INSERT ON public.teams FOR EACH ROW EXECUTE FUNCTION public.tai_teams();
