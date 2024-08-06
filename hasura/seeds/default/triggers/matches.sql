CREATE OR REPLACE FUNCTION public.tbi_match() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _lineup_1_id UUID;
    _lineup_2_id UUID;
BEGIN
    IF NEW.lineup_1_id IS NULL THEN
        INSERT INTO match_lineups DEFAULT VALUES RETURNING id INTO _lineup_1_id;
         NEW.lineup_1_id = _lineup_1_id;
    END IF;

    IF NEW.lineup_2_id IS NULL THEN
       INSERT INTO match_lineups DEFAULT VALUES RETURNING id INTO _lineup_2_id;
       NEW.lineup_2_id = _lineup_2_id;
    END IF;

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

CREATE OR REPLACE FUNCTION public.tbu_matches() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF(OLD.status = 'Finished' AND NEW.status = 'Canceled') THEN
      RAISE EXCEPTION 'Cannot cancel a match that is already finished' USING ERRCODE = '22000';
    END IF;

    PERFORM check_match_status(NEW);
    PERFORM check_match_player_count(NEW);
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_matches ON public.matches;
CREATE TRIGGER tbu_matches BEFORE UPDATE ON public.matches FOR EACH ROW EXECUTE FUNCTION public.tbu_matches();
