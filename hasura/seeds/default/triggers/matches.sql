CREATE OR REPLACE FUNCTION public.tbi_match() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM create_match_lineups(NEW);
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_match ON public.matches;
CREATE TRIGGER tbi_match BEFORE INSERT ON public.matches FOR EACH ROW EXECUTE FUNCTION public.tbi_match();


CREATE OR REPLACE FUNCTION public.tau_matches() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM update_tournament_bracket(NEW);
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_matches ON public.matches;
CREATE TRIGGER tau_matches AFTER UPDATE ON public.matches FOR EACH ROW EXECUTE FUNCTION public.tau_matches();