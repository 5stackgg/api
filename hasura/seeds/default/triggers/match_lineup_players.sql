CREATE OR REPLACE FUNCTION public.tbi_match_lineup_players() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM check_match_lineup_players_count(NEW);
    PERFORM check_match_lineup_players(NEW);
	RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tbu_match_lineup_players() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM check_match_lineup_players(NEW);
	RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS tbi_match_lineup_players ON public.match_lineup_players;
CREATE TRIGGER tbi_match_lineup_players BEFORE INSERT ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.tbi_match_lineup_players();

DROP TRIGGER IF EXISTS tbu_match_lineup_players ON public.match_lineup_players;
CREATE TRIGGER tbu_match_lineup_players BEFORE UPDATE ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.tbu_match_lineup_players();
