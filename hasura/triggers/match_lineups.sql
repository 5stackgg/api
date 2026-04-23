CREATE OR REPLACE FUNCTION public.tbu_match_lineups()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    _match_status text;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.team_name != OLD.team_name THEN
        select status from matches where lineup_1_id = NEW.id or lineup_2_id = NEW.id into _match_status;
        IF _match_status NOT IN ('PickingPlayers', 'Scheduled', 'WaitingForCheckIn', 'Veto', 'WaitingForServer') THEN
            RAISE EXCEPTION 'Cannot change the name of a lineup when the match is Live or Finished' USING ERRCODE = '22000';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_match_lineups ON public.match_lineups;
CREATE TRIGGER tbu_match_lineups BEFORE INSERT OR UPDATE ON public.match_lineups FOR EACH ROW EXECUTE FUNCTION public.tbu_match_lineups();

CREATE OR REPLACE FUNCTION public.tau_match_lineups()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    _match matches;
    _max_players_per_lineup int;
    _team_captain_steam_id bigint;
    _member RECORD;
BEGIN
    IF TG_OP != 'UPDATE' THEN
        RETURN NEW;
    END IF;

    IF NEW.team_id IS NULL OR NEW.team_id IS NOT DISTINCT FROM OLD.team_id THEN
        RETURN NEW;
    END IF;

    SELECT *
    INTO _match
    FROM matches m
    WHERE m.lineup_1_id = NEW.id OR m.lineup_2_id = NEW.id
    LIMIT 1;

    IF _match.id IS NULL OR _match.status != 'PickingPlayers' THEN
        RETURN NEW;
    END IF;

    SELECT t.captain_steam_id
    INTO _team_captain_steam_id
    FROM teams t
    WHERE t.id = NEW.team_id;

    DELETE FROM match_lineup_players
    WHERE match_lineup_id = NEW.id;

    SELECT match_max_players_per_lineup(_match) INTO _max_players_per_lineup;

    FOR _member IN
        SELECT tr.player_steam_id
        FROM team_roster tr
        WHERE tr.team_id = NEW.team_id
        ORDER BY
            CASE
                WHEN tr.player_steam_id = _team_captain_steam_id THEN 0
                ELSE 1
            END,
            CASE tr.status
                WHEN 'Starter' THEN 1
                WHEN 'Substitute' THEN 2
                WHEN 'Benched' THEN 3
                ELSE 4
            END
        LIMIT _max_players_per_lineup
    LOOP
        INSERT INTO match_lineup_players (match_lineup_id, steam_id)
        VALUES (NEW.id, _member.player_steam_id);
    END LOOP;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_match_lineups ON public.match_lineups;
CREATE TRIGGER tau_match_lineups AFTER UPDATE ON public.match_lineups FOR EACH ROW EXECUTE FUNCTION public.tau_match_lineups();
