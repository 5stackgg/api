CREATE OR REPLACE FUNCTION public.advance_swiss_teams(_stage_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    stage_record RECORD;
    next_stage_id uuid;
    advanced_teams uuid[];
    eliminated_count int;
BEGIN
    -- Get stage information
    SELECT ts.tournament_id, ts."order"
    INTO stage_record
    FROM tournament_stages ts
    WHERE ts.id = _stage_id;
    
    IF stage_record IS NULL THEN
        RAISE EXCEPTION 'Stage % not found', _stage_id;
    END IF;
    
    -- Get teams with 3 wins (should advance to next stage)
    SELECT array_agg(vtsr.tournament_team_id)
    INTO advanced_teams
    FROM v_team_stage_results vtsr
    WHERE vtsr.tournament_stage_id = _stage_id
      AND vtsr.wins >= 3;
    
    -- Count teams with 3 losses (eliminated)
    SELECT COUNT(*)
    INTO eliminated_count
    FROM v_team_stage_results vtsr
    WHERE vtsr.tournament_stage_id = _stage_id
      AND vtsr.losses >= 3;
    
    RAISE NOTICE '=== Processing Swiss Advancement ===';
    RAISE NOTICE 'Teams with 3+ wins: %', COALESCE(array_length(advanced_teams, 1), 0);
    RAISE NOTICE 'Teams with 3+ losses: %', eliminated_count;
    
    -- Check if stage is complete (all teams have 3+ wins or 3+ losses)
    DECLARE
        remaining_teams int;
        stage_complete boolean;
    BEGIN
        SELECT COUNT(*)
        INTO remaining_teams
        FROM v_team_stage_results vtsr
        WHERE vtsr.tournament_stage_id = _stage_id
          AND vtsr.wins < 3
          AND vtsr.losses < 3;
        
        stage_complete := (remaining_teams = 0);
        
        -- Advance teams to next stage if it exists
        IF advanced_teams IS NOT NULL AND array_length(advanced_teams, 1) > 0 THEN
            SELECT ts.id INTO next_stage_id
            FROM tournament_stages ts
            WHERE ts.tournament_id = stage_record.tournament_id
              AND ts."order" = stage_record."order" + 1;
            
            IF next_stage_id IS NOT NULL THEN
                RAISE NOTICE 'Advancing % teams to next stage', array_length(advanced_teams, 1);
                
                -- If stage is complete, seed the next stage
                IF stage_complete THEN
                    RAISE NOTICE 'Swiss stage complete, seeding next stage';
                    PERFORM seed_stage(next_stage_id);
                END IF;
            ELSE
                RAISE NOTICE 'No next stage found - teams have won the tournament';
            END IF;
        END IF;
        
        -- Teams with 3 losses are eliminated (they stop playing)
        -- This is handled by filtering them out in get_swiss_team_pools
    END;
    
    RAISE NOTICE '=== Swiss Advancement Complete ===';
END;
$$;

