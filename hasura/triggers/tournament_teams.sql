CREATE OR REPLACE FUNCTION public.tbi_tournament_team()
 RETURNS trigger
 LANGUAGE plpgsql
AS $$
DECLARE
    tournament tournaments;
BEGIN
    SELECT * INTO tournament
    FROM tournaments
    WHERE id = NEW.tournament_id;

    IF NEW.team_id IS NOT NULL THEN
       select owner_steam_id into NEW.owner_steam_id from teams where id = NEW.team_id;
    END IF;

    RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS tbi_tournament_team ON public.tournament_teams;
CREATE TRIGGER tbi_tournament_team BEFORE INSERT ON public.tournament_teams FOR EACH ROW EXECUTE FUNCTION public.tbi_tournament_team();


CREATE OR REPLACE FUNCTION public.tbd_tournament_team()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    tournament_status text;
BEGIN
    SELECT status
    INTO tournament_status
    FROM tournaments
    WHERE id = NEW.tournament_id;

    IF tournament_status = 'Cancelled' OR tournament_status = 'CancelledMinTeams' OR tournament_status = 'Finished' THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot leave an active tournament';
    END IF;

    RETURN OLD;
END;
$$;


DROP TRIGGER IF EXISTS tbd_tournament_team ON public.tournament_teams;
CREATE TRIGGER tbd_tournament_team BEFORE DELETE ON public.tournament_teams FOR EACH ROW EXECUTE FUNCTION public.tbd_tournament_team();
