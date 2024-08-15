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
     IF NEW.captain = true THEN
        UPDATE match_lineup_players
            SET captain = false
            WHERE match_lineup_id = NEW.match_lineup_id AND steam_id != NEW.steam_id;
    END IF;

	RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tbiud_match_lineup_players()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    status text;
BEGIN
    SELECT m.status INTO status
    FROM matches m
    INNER JOIN v_match_lineups ml ON ml.match_id = m.id
    WHERE ml.id = COALESCE(NEW.match_lineup_id, OLD.match_lineup_id);

    IF status != 'PickingPlayers' AND status != 'Scheduled' THEN
        RAISE EXCEPTION 'Cannot add players: not in picking players status' USING ERRCODE = '22000';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;


DROP TRIGGER IF EXISTS tbi_match_lineup_players ON public.match_lineup_players;
CREATE TRIGGER tbi_match_lineup_players BEFORE INSERT ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.tbi_match_lineup_players();

DROP TRIGGER IF EXISTS tbu_match_lineup_players ON public.match_lineup_players;
CREATE TRIGGER tbu_match_lineup_players BEFORE UPDATE ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.tbu_match_lineup_players();

DROP TRIGGER IF EXISTS tbiud_match_lineup_players ON public.match_lineup_players;
CREATE TRIGGER tbiud_match_lineup_players BEFORE INSERT OR UPDATE OR DELETE ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.tbiud_match_lineup_players();
