CREATE OR REPLACE FUNCTION public.tbi_tournament_team() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    tournament tournaments
BEGIN
    select * into tournaments where id = NEW.tournament_id;


    IF can_join_tournament(NEW, current_setting('hasura.user', true)::json) THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot join the tournament';
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
