CREATE OR REPLACE FUNCTION public.tau_tournament_brackets() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    stage_type text;
    tournament_status text;
    _match_status text;
    _fallback_options_id UUID;
BEGIN
     -- Match scheduling logic: only run when no match exists yet
     IF OLD.match_id IS NULL THEN
         -- Don't schedule if bracket is already finished
         IF NEW.finished = true THEN
            return NEW;
         END IF;

         IF NEW.match_id IS NULL THEN
             -- Check if this is a RoundRobin stage
             SELECT ts.type INTO stage_type
             FROM tournament_stages ts
             WHERE ts.id = NEW.tournament_stage_id;

             -- For RoundRobin stages, only schedule round 1 matches initially
             -- Later rounds will be scheduled progressively when previous rounds complete
             IF stage_type = 'RoundRobin' AND NEW.round > 1 THEN
                 RETURN NEW;  -- Skip scheduling for round > 1 in RoundRobin
             END IF;

             raise notice 'Scheduling match for bracket %', NEW.id;
             IF NEW.tournament_team_id_1 IS NOT NULL AND NEW.tournament_team_id_2 IS NOT NULL THEN
                PERFORM schedule_tournament_match(NEW);
             END IF;
         END IF;
     END IF;

    -- Match options change logic
    IF OLD.match_options_id IS DISTINCT FROM NEW.match_options_id THEN
        SELECT t.status INTO tournament_status
        FROM tournaments t
        JOIN tournament_stages ts ON ts.tournament_id = t.id
        WHERE ts.id = NEW.tournament_stage_id;

        IF tournament_status NOT IN ('Setup', 'RegistrationOpen', 'RegistrationClosed', 'Live') THEN
            RAISE EXCEPTION 'Tournament status must be Setup, Registration Open, Registration Closed or Live' USING ERRCODE = '22000';
        END IF;

        -- If bracket has a match, check match status and propagate
        IF NEW.match_id IS NOT NULL THEN
            SELECT status INTO _match_status FROM matches WHERE id = NEW.match_id;

            IF _match_status IN ('Veto', 'Live', 'Finished', 'Forfeit', 'Tie', 'Surrendered') THEN
                RAISE EXCEPTION 'Cannot modify match options for a match that is in progress or completed' USING ERRCODE = '22000';
            END IF;

            -- Propagate match_options_id to the match
            IF NEW.match_options_id IS NOT NULL THEN
                UPDATE matches SET match_options_id = NEW.match_options_id WHERE id = NEW.match_id;
            ELSE
                -- Revert: compute fallback from stage or tournament
                SELECT COALESCE(ts.match_options_id, t.match_options_id)
                INTO _fallback_options_id
                FROM tournament_stages ts
                JOIN tournaments t ON t.id = ts.tournament_id
                WHERE ts.id = NEW.tournament_stage_id;

                UPDATE matches SET match_options_id = _fallback_options_id WHERE id = NEW.match_id;
            END IF;
        END IF;
    END IF;

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_tournament_brackets ON public.tournament_brackets;
CREATE TRIGGER tau_tournament_brackets AFTER UPDATE ON public.tournament_brackets FOR EACH ROW EXECUTE FUNCTION public.tau_tournament_brackets();

CREATE OR REPLACE FUNCTION public.tbd_tournament_brackets() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.match_id IS NOT NULL THEN
        DELETE FROM matches WHERE id = OLD.match_id;
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tbd_tournament_brackets ON public.tournament_brackets;
CREATE TRIGGER tbd_tournament_brackets
    BEFORE DELETE ON public.tournament_brackets
    FOR EACH ROW
    EXECUTE FUNCTION public.tbd_tournament_brackets();
