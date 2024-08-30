CREATE OR REPLACE FUNCTION public.tau_tournaments() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN

    IF (NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'Live') THEN
        PERFORM seed_tournament(NEW);
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
                IF can_cancel_tournament(NEW, current_setting('hasura.user', true)::json) THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot cancel tournament';
                END IF;
            WHEN 'RegistrationOpen' THEN
                IF can_open_tournament_registration(NEW, current_setting('hasura.user', true)::json) THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot cancel tournament';
                END IF;
            WHEN 'RegistrationClose' THEN
                IF can_close_tournament_registration(NEW, current_setting('hasura.user', true)::json) THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot cancel tournament';
                END IF;
            ELSE
              RAISE EXCEPTION 'Cannot update tournament status to , %', NEW.status USING ERRCODE = '22000';
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
