-- Shared validation function for tournament stages
CREATE OR REPLACE FUNCTION public.validate_tournament_stage(
    p_stage_type text,
    p_groups integer,
    p_min_teams integer,
    p_stage_order integer,
    p_tournament_id uuid,
    p_stage_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    prev_stage_record RECORD;
    max_teams_advancing int;
    last_round_matches int;
BEGIN
    -- Validate Swiss tournament requirements
    IF p_stage_type = 'Swiss' THEN
        -- Swiss tournaments use single group
        IF p_groups IS NOT NULL AND p_groups != 1 THEN
            RAISE EXCEPTION 'Swiss tournaments must use a single group (groups = 1). Current: %', 
                p_groups USING ERRCODE = '22000';
        END IF;
        -- Note: Odd numbers are handled by pairing with adjacent pools
    END IF;

    -- Validate first stage minimum teams (must be at least 4 * number of groups)
    IF p_stage_order = 1 AND p_groups IS NOT NULL AND p_groups > 0 AND p_stage_type != 'Swiss' THEN
        IF p_min_teams < 4 * p_groups THEN
            RAISE EXCEPTION 'First stage must have at least % teams given % groups (minimum 4 teams per group)', 
                4 * p_groups, p_groups USING ERRCODE = '22000';
        END IF;
    END IF;
    
    -- Validate that this stage can accommodate teams advancing from the previous stage
    IF p_stage_order > 1 THEN
        -- Get the previous stage
        SELECT * INTO prev_stage_record
        FROM tournament_stages 
        WHERE tournament_id = p_tournament_id AND "order" = p_stage_order - 1;
        
        IF prev_stage_record.id IS NOT NULL THEN
            -- Calculate max teams that can advance from previous stage
            -- Count matches in the last round of the previous stage (each match produces 1 winner)
            SELECT COUNT(*) INTO last_round_matches
            FROM tournament_brackets tb
            WHERE tb.tournament_stage_id = prev_stage_record.id
              AND tb.round = (
                  SELECT MAX(tb2.round)
                  FROM tournament_brackets tb2
                  WHERE tb2.tournament_stage_id = prev_stage_record.id
              );
            
            -- If brackets haven't been created yet, fall back to calculation based on min_teams
            IF last_round_matches = 0 THEN
                -- Fallback: estimate based on min_teams and groups
                max_teams_advancing := (prev_stage_record.min_teams / prev_stage_record.groups) / 2;
            ELSE
                -- Use actual number of matches in last round (each match = 1 advancing team)
                max_teams_advancing := last_round_matches;
            END IF;
            
            -- This stage must be able to accommodate the advancing teams
            IF p_min_teams < max_teams_advancing THEN
                RAISE EXCEPTION 'Stage % cannot accommodate % teams advancing from stage % (min_teams: %)', 
                    p_stage_order, max_teams_advancing, p_stage_order - 1, p_min_teams 
                    USING ERRCODE = '22000';
            END IF;
        END IF;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.taiu_tournament_stages()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    stage_record RECORD;
    _min_teams INTEGER;
    next_min_teams INTEGER;
    current_order INTEGER;
    next_stage_record RECORD;
BEGIN
    BEGIN
        PERFORM 1 FROM pg_temp.taiu_running_flag LIMIT 1;
        RETURN NEW;
    EXCEPTION
        WHEN undefined_table THEN
            NULL;
    END;
    
    CREATE TEMP TABLE taiu_running_flag (dummy int);

    BEGIN
        current_order := NEW."order";
        IF current_order <= 0 THEN
            current_order := 1;
        END IF;
        
        _min_teams := NEW.min_teams;

        -- Validate stage using shared validation function
        PERFORM validate_tournament_stage(
            NEW.type,
            NEW.groups,
            NEW.min_teams,
            current_order,
            NEW.tournament_id,
            NEW.id
        );

        FOR stage_record IN 
            SELECT * FROM tournament_stages 
            WHERE tournament_id = NEW.tournament_id 
            AND id != NEW.id
            ORDER BY "order" ASC
        LOOP
            IF stage_record."order" < current_order THEN
                next_min_teams := _min_teams * (2 ^ (current_order - stage_record."order"));
            ELSE
                next_min_teams := _min_teams / (2 ^ (stage_record."order" - current_order));
            END IF;

            IF(next_min_teams < 1) THEN
                RAISE EXCEPTION 'Unable to update stage % to % teams', stage_record."order", next_min_teams USING ERRCODE = '22000';
            END IF;
            
            IF stage_record.min_teams < next_min_teams THEN
                UPDATE tournament_stages 
                SET min_teams = next_min_teams
                WHERE id = stage_record.id;
            END IF;

            IF stage_record.max_teams < next_min_teams THEN
                UPDATE tournament_stages 
                SET max_teams = next_min_teams
                WHERE id = stage_record.id;
            END IF;
        END LOOP;
        
        -- Validate groups number can divide next stage's min_teams with remainder 0
        -- This check happens after all stages have been updated
        IF NEW.groups IS NOT NULL AND NEW.groups > 1 THEN
            -- Get the next stage in sequence
            SELECT * INTO next_stage_record
            FROM tournament_stages 
            WHERE tournament_id = NEW.tournament_id AND "order" = current_order + 1;
            
            IF next_stage_record.id IS NOT NULL THEN
                -- Check if groups can divide next stage's min_teams evenly
                IF next_stage_record.min_teams % NEW.groups != 0 THEN
                    RAISE EXCEPTION 'Invalid Groups (%) for stage %', 
                        NEW.groups, NEW.order USING ERRCODE = '22000';
                END IF;
            END IF;
        END IF;
        
        -- Check if we're creating a decider stage (skip regeneration in that case)
        BEGIN
            PERFORM 1 FROM pg_temp.creating_decider_stage WHERE stage_id = NEW.id;
            IF FOUND THEN
                RAISE NOTICE 'Skipping update_tournament_stages for decider stage %', NEW.id;
            ELSE
                PERFORM update_tournament_stages(NEW.tournament_id);
            END IF;
        EXCEPTION
            WHEN undefined_table THEN
                -- Temp table doesn't exist, proceed normally
                PERFORM update_tournament_stages(NEW.tournament_id);
        END;
    EXCEPTION
        WHEN OTHERS THEN
            DROP TABLE IF EXISTS pg_temp.taiu_running_flag;
            RAISE;
    END;

    DROP TABLE IF EXISTS pg_temp.taiu_running_flag;

    RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS taiu_tournament_stages ON public.tournament_stages;
CREATE TRIGGER taiu_tournament_stages AFTER INSERT OR UPDATE ON public.tournament_stages FOR EACH ROW EXECUTE FUNCTION public.taiu_tournament_stages();

CREATE OR REPLACE FUNCTION public.tbu_tournament_stages()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    tournament_status text;
    stage_has_matches boolean;
BEGIN
    SELECT status
    INTO tournament_status
    FROM tournaments t
    WHERE t.id = NEW.tournament_id;

    IF tournament_status = 'Live' OR tournament_status = 'Finished' THEN
        RAISE EXCEPTION 'Unable to modify stage since the tournament has been started' USING ERRCODE = '22000';
    END IF;

    -- Check if stage has started (has at least one match created)
    SELECT EXISTS (
        SELECT 1 
        FROM tournament_brackets tb 
        WHERE tb.tournament_stage_id = NEW.id 
        AND tb.match_id IS NOT NULL
    ) INTO stage_has_matches;

    -- Prevent match_options_id changes once stage has started
    IF stage_has_matches AND OLD.match_options_id IS DISTINCT FROM NEW.match_options_id THEN
        RAISE EXCEPTION 'Unable to modify match options for a stage that has already started' USING ERRCODE = '22000';
    END IF;

    IF OLD.max_teams != NEW.max_teams THEN
          IF NEW.min_teams > NEW.max_teams THEN
            NEW.min_teams = NEW.max_teams;
        END IF;
    END IF;

    IF OLD.min_teams != NEW.min_teams THEN
        IF NEW.max_teams < NEW.min_teams THEN
            NEW.max_teams = NEW.min_teams;
        END IF;
    END IF;

    -- Validate stage using shared validation function
    PERFORM validate_tournament_stage(
        NEW.type,
        NEW.groups,
        NEW.min_teams,
        NEW."order",
        NEW.tournament_id,
        NEW.id
    );

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_tournament_stages ON public.tournament_stages;
CREATE TRIGGER tbu_tournament_stages BEFORE UPDATE ON public.tournament_stages FOR EACH ROW EXECUTE FUNCTION public.tbu_tournament_stages();

CREATE OR REPLACE FUNCTION public.tbd_tournament_stages() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    DELETE FROM tournament_brackets
        WHERE tournament_stage_id = OLD.id;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tbd_tournament_stages ON public.tournament_stages;
CREATE TRIGGER tbd_tournament_stages
    BEFORE DELETE ON public.tournament_stages
    FOR EACH ROW
    EXECUTE FUNCTION public.tbd_tournament_stages();


CREATE OR REPLACE FUNCTION public.tad_tournament_stages() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM update_tournament_stages(OLD.tournament_id);
    RETURN OLD;
END;
$$;


DROP TRIGGER IF EXISTS tad_tournament_stages ON public.tournament_stages;
CREATE TRIGGER tad_tournament_stages AFTER DELETE ON public.tournament_stages FOR EACH ROW EXECUTE FUNCTION public.tad_tournament_stages(); 