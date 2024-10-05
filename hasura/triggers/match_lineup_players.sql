DROP TRIGGER IF EXISTS tbi_match_lineup_players ON public.match_lineup_players;
drop function if exists public.tbi_match_lineup_players;

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

CREATE OR REPLACE FUNCTION public.tbid_match_lineup_players()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    status text;
    lineup_count INT;
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
        select check_match_lineup_players_count(NEW) into lineup_count;

        IF lineup_count = 0 THEN
            NEW.captain = true;
        END IF;

        PERFORM check_match_lineup_players(NEW);

        RETURN NEW;
    END IF;
END;
$$;


DROP TRIGGER IF EXISTS tbu_match_lineup_players ON public.match_lineup_players;
CREATE TRIGGER tbu_match_lineup_players BEFORE UPDATE ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.tbu_match_lineup_players();

DROP TRIGGER IF EXISTS tbid_match_lineup_players ON public.match_lineup_players;
CREATE TRIGGER tbid_match_lineup_players BEFORE INSERT OR DELETE ON public.match_lineup_players FOR EACH ROW EXECUTE FUNCTION public.tbid_match_lineup_players();
