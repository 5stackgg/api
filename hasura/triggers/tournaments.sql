CREATE OR REPLACE FUNCTION public.tau_tournaments() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    tournament_matches uuid[];
BEGIN

    IF (NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'Live') THEN
        PERFORM seed_tournament(NEW);
    END IF;

    IF (NEW.status = 'Cancelled' OR NEW.status = 'CancelledMinTeams') THEN
        PERFORM delete_tournament_brackets_and_matches(NEW.id);
    END IF;

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_tournaments ON public.tournaments;
CREATE TRIGGER tau_tournaments AFTER UPDATE ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.tau_tournaments();

CREATE OR REPLACE FUNCTION public.tad_tournaments() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM match_options
       WHERE id = OLD.match_options_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tad_tournaments ON public.tournaments;
CREATE TRIGGER tad_tournaments AFTER DELETE ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.tad_tournaments();


CREATE OR REPLACE FUNCTION public.tbu_tournaments() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        CASE NEW.status
            WHEN 'Cancelled' THEN
                IF NOT can_cancel_tournament(OLD, current_setting('hasura.user', true)::json) THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot cancel tournament';
                END IF;
            WHEN 'RegistrationOpen' THEN
                IF NOT can_open_tournament_registration(OLD, current_setting('hasura.user', true)::json) THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot open tournament registration';
                END IF;
            WHEN 'RegistrationClose' THEN
                IF NOT can_close_tournament_registration(OLD, current_setting('hasura.user', true)::json) THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot close tournament registration';
                END IF;
            WHEN 'Live' THEN
                IF NOT tournament_has_min_teams(NEW) THEN 
                    NEW.status = 'CancelledMinTeams';
                END IF;
            ELSE
                -- No action needed for other status changes
        END CASE;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_tournaments ON public.tournaments;
CREATE TRIGGER tbu_tournaments
    BEFORE UPDATE ON public.tournaments
    FOR EACH ROW
    EXECUTE FUNCTION public.tbu_tournaments();

CREATE OR REPLACE FUNCTION public.tbd_tournaments() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    DELETE FROM tournament_stages
        WHERE tournament_id = OLD.id;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tbd_tournaments ON public.tournaments;
CREATE TRIGGER tbd_tournaments
    BEFORE DELETE ON public.tournaments
    FOR EACH ROW
    EXECUTE FUNCTION public.tbd_tournaments();
