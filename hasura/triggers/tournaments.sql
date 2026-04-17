CREATE OR REPLACE FUNCTION public.tau_tournaments() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    first_stage_id uuid;
    bracket_row tournament_brackets%ROWTYPE;
BEGIN
    IF (
         NEW.status IS DISTINCT FROM OLD.status AND
         NEW.status IN ('RegistrationOpen')
    ) THEN
        PERFORM update_tournament_stages(NEW.id);
        return NEW;
    END IF;

    IF (
        NEW.status IS DISTINCT FROM OLD.status AND
        NEW.status IN ('Live', 'RegistrationClosed') AND
        OLD.status IN ('Setup', 'RegistrationOpen')
    ) THEN
        PERFORM update_tournament_stages(NEW.id);
        PERFORM assign_seeds_to_teams(NEW);
        
        SELECT id INTO first_stage_id
        FROM tournament_stages
        WHERE tournament_id = NEW.id AND "order" = 1
        LIMIT 1;
        
        IF first_stage_id IS NOT NULL THEN
            PERFORM seed_stage(first_stage_id);
        END IF;
    END IF;

    -- When tournament resumes from Paused, schedule all ready brackets (only if auto_start)
    IF (
        NEW.status IS DISTINCT FROM OLD.status AND
        OLD.status = 'Paused' AND NEW.status = 'Live'
        AND NEW.auto_start
    ) THEN
        -- Resolve runtime byes first (one team, no pending feeders)
        -- Process lower rounds first so cascading byes propagate correctly
        FOR bracket_row IN
            SELECT tb.*
            FROM tournament_brackets tb
            INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
            WHERE ts.tournament_id = NEW.id
              AND tb.match_id IS NULL
              AND tb.finished = false
              AND tb.bye = false
              AND ((tb.tournament_team_id_1 IS NOT NULL AND tb.tournament_team_id_2 IS NULL)
                OR (tb.tournament_team_id_1 IS NULL AND tb.tournament_team_id_2 IS NOT NULL))
            ORDER BY tb.round, tb.match_number
        LOOP
            PERFORM resolve_bracket_bye(bracket_row);
        END LOOP;

        -- Then schedule matches with both teams present
        FOR bracket_row IN
            SELECT tb.*
            FROM tournament_brackets tb
            INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
            WHERE ts.tournament_id = NEW.id
              AND tb.match_id IS NULL
              AND tb.finished = false
              AND tb.tournament_team_id_1 IS NOT NULL
              AND tb.tournament_team_id_2 IS NOT NULL
            ORDER BY tb.round, tb.match_number
        LOOP
            PERFORM schedule_tournament_match(bracket_row);
        END LOOP;

        PERFORM calculate_tournament_bracket_start_times(NEW.id);
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
  PERFORM cleanup_orphaned_match_options(OLD.match_options_id);

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
            WHEN 'Setup' THEN
                IF NOT can_setup_tournament(OLD, current_setting('hasura.user', true)::json) THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot reset tournament to setup';
                END IF;
            WHEN 'Cancelled' THEN
                IF NOT can_cancel_tournament(OLD, current_setting('hasura.user', true)::json) THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot cancel tournament';
                END IF;
            WHEN 'RegistrationOpen' THEN
                IF NOT can_open_tournament_registration(OLD, current_setting('hasura.user', true)::json) THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot open tournament registration';
                END IF;
            WHEN 'RegistrationClosed' THEN
                IF NOT can_close_tournament_registration(OLD, current_setting('hasura.user', true)::json) THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot close tournament registration';
                END IF;
            WHEN 'Live' THEN
                IF OLD.status = 'Paused' THEN
                    IF NOT can_resume_tournament(OLD, current_setting('hasura.user', true)::json) THEN
                        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot resume tournament';
                    END IF;
                ELSE
                    IF NOT tournament_has_min_teams(NEW) THEN
                        NEW.status = 'CancelledMinTeams';
                    END IF;
                END IF;
            WHEN 'Paused' THEN
                IF NOT can_pause_tournament(OLD, current_setting('hasura.user', true)::json) THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Cannot pause tournament';
                END IF;
            WHEN 'Finished' THEN
                IF NOT (
                    (current_setting('hasura.user', true)::json->>'x-hasura-role') IN ('admin', 'administrator')
                ) THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Tournament finish is handled automatically';
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

CREATE OR REPLACE FUNCTION public.tbi_tournaments() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.discord_notifications_enabled IS NULL THEN
        IF EXISTS (
            SELECT 1
            FROM public.settings
            WHERE name LIKE 'discord_match_notify_%'
              AND value = 'true'
        ) THEN
            NEW.discord_notifications_enabled := true;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_tournaments ON public.tournaments;
CREATE TRIGGER tbi_tournaments
    BEFORE INSERT ON public.tournaments
    FOR EACH ROW
    EXECUTE FUNCTION public.tbi_tournaments();
