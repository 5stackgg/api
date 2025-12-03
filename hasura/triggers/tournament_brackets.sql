CREATE OR REPLACE FUNCTION public.tau_tournament_brackets() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
     IF NEW.match_id IS NULL THEN
         -- Normal case: schedule when both teams are present
         IF NEW.tournament_team_id_1 IS NOT NULL AND NEW.tournament_team_id_2 IS NOT NULL THEN
             PERFORM schedule_tournament_match(NEW);
         -- Losers bracket special case: allow schedule_tournament_match to decide if this should be a bye
         ELSIF COALESCE(NEW.path, 'WB') = 'LB' AND
               (NEW.tournament_team_id_1 IS NOT NULL OR NEW.tournament_team_id_2 IS NOT NULL) THEN
             PERFORM schedule_tournament_match(NEW);
         END IF;
     END IF;

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_tournament_brackets ON public.tournament_brackets;
CREATE TRIGGER tau_tournament_brackets AFTER UPDATE ON public.tournament_brackets FOR EACH ROW EXECUTE FUNCTION public.tau_tournament_brackets();
