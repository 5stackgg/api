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
        
                -- Validate that this stage can accommodate teams advancing from the previous stage
        IF current_order > 1 THEN
            DECLARE
                prev_stage_record RECORD;
                max_teams_advancing int;
            BEGIN
                -- Get the previous stage
                SELECT * INTO prev_stage_record
                FROM tournament_stages 
                WHERE tournament_id = NEW.tournament_id AND "order" = current_order - 1;
                
                IF prev_stage_record.id IS NOT NULL THEN
                                    -- Calculate max teams that can advance from previous stage
                -- Formula: (min_teams / groups) / 2 = max_teams_to_next_round
                max_teams_advancing := (prev_stage_record.min_teams / prev_stage_record.groups) / 2;
                    
                    -- This stage must be able to accommodate the advancing teams
                    IF NEW.min_teams < max_teams_advancing THEN
                        RAISE EXCEPTION 'Stage % cannot accommodate % teams advancing from stage % (min_teams: %)', 
                            current_order, max_teams_advancing, current_order - 1, NEW.min_teams 
                            USING ERRCODE = '22000';
                    END IF;
                END IF;
            END;
        END IF;
        
        PERFORM update_tournament_stages(NEW.tournament_id);
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
BEGIN
    SELECT status
    INTO tournament_status
    FROM tournaments t
    WHERE t.id = NEW.tournament_id;

    IF tournament_status != 'Setup' THEN
        RAISE EXCEPTION 'Unable to modify stage since the tournament has been started';
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
    
    -- Validate that this stage can accommodate teams advancing from the previous stage
    IF NEW."order" > 1 THEN
        DECLARE
            prev_stage_record RECORD;
            max_teams_advancing int;
        BEGIN
            -- Get the previous stage
            SELECT * INTO prev_stage_record
            FROM tournament_stages 
            WHERE tournament_id = NEW.tournament_id AND "order" = NEW."order" - 1;
            
            IF prev_stage_record.id IS NOT NULL THEN
                -- Calculate max teams that can advance from previous stage
                -- Formula: (min_teams / groups) / 2 = max_teams_to_next_round
                max_teams_advancing := (prev_stage_record.min_teams / prev_stage_record.groups) / 2;
                
                -- This stage must be able to accommodate the advancing teams
                IF NEW.min_teams < max_teams_advancing THEN
                    RAISE EXCEPTION 'Stage % cannot accommodate % teams advancing from stage % (min_teams: %)', 
                        NEW."order", max_teams_advancing, NEW."order" - 1, NEW.min_teams 
                        USING ERRCODE = '22000';
                END IF;
            END IF;
        END;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_tournament_stages ON public.tournament_stages;
CREATE TRIGGER tbu_tournament_stages BEFORE UPDATE ON public.tournament_stages FOR EACH ROW EXECUTE FUNCTION public.tbu_tournament_stages();

