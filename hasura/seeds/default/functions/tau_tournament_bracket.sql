CREATE OR REPLACE FUNCTION public.tau_tournament_bracket() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.tournament_team_id_1 IS NULL OR NEW.tournament_team_id_2 IS NULL OR NEW.match_id IS NOT NULL THEN
        RETURN NEW;
    END IF;
    PERFORM schedule_tournament_match(NEW);
    RETURN NEW;
END;
$$;