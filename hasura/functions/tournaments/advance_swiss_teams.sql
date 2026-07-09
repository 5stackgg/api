CREATE OR REPLACE FUNCTION public.advance_swiss_teams(_stage_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    stage_record RECORD;
    next_stage_id uuid;
    advanced_teams uuid[];
    eliminated_count int;
    _no_elim boolean;
    _max_rounds int;
BEGIN
    SELECT ts.tournament_id, ts."order",
           COALESCE(ts.swiss_no_elimination, false) AS swiss_no_elimination,
           ts.max_rounds
    INTO stage_record
    FROM tournament_stages ts
    WHERE ts.id = _stage_id;

    IF stage_record IS NULL THEN
        RAISE EXCEPTION 'Stage % not found', _stage_id USING ERRCODE = '22000';
    END IF;

    _no_elim := stage_record.swiss_no_elimination;
    _max_rounds := stage_record.max_rounds;

    -- No-elimination "group": the stage completes when the final round is done;
    -- the next stage (playoffs) seeds from the standings, not from a 3-0 record.
    IF _no_elim THEN
        IF _max_rounds IS NOT NULL AND public.check_swiss_round_complete(_stage_id, _max_rounds) THEN
            SELECT ts.id INTO next_stage_id
            FROM tournament_stages ts
            WHERE ts.tournament_id = stage_record.tournament_id
              AND ts."order" = stage_record."order" + 1;
            IF next_stage_id IS NOT NULL THEN
                PERFORM seed_stage(next_stage_id);
            END IF;
        END IF;
        RETURN;
    END IF;

    SELECT array_agg(vtsr.tournament_team_id)
    INTO advanced_teams
    FROM v_team_stage_results vtsr
    WHERE vtsr.tournament_stage_id = _stage_id
      AND vtsr.wins >= 3;
    
    SELECT COUNT(*)
    INTO eliminated_count
    FROM v_team_stage_results vtsr
    WHERE vtsr.tournament_stage_id = _stage_id
      AND vtsr.losses >= 3;
    
    RAISE NOTICE '=== Processing Swiss Advancement ===';
    RAISE NOTICE 'Teams with 3+ wins: %', COALESCE(array_length(advanced_teams, 1), 0);
    RAISE NOTICE 'Teams with 3+ losses: %', eliminated_count;
    
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
        
        IF advanced_teams IS NOT NULL AND array_length(advanced_teams, 1) > 0 THEN
            SELECT ts.id INTO next_stage_id
            FROM tournament_stages ts
            WHERE ts.tournament_id = stage_record.tournament_id
              AND ts."order" = stage_record."order" + 1;
            
            IF next_stage_id IS NOT NULL THEN
                RAISE NOTICE 'Advancing % teams to next stage', array_length(advanced_teams, 1);
                
                -- Only seed the next stage if the current stage is complete AND we have teams to advance
                IF stage_complete THEN
                    RAISE NOTICE 'Swiss stage complete, advancing teams to next stage';
                    PERFORM seed_stage(next_stage_id);
                END IF;
            ELSE
                RAISE NOTICE 'No next stage found - teams have won the tournament';
            END IF;
        ELSIF stage_complete THEN
            -- Stage is complete but no teams advanced (shouldn't happen in normal Swiss, but handle gracefully)
            RAISE NOTICE 'Swiss stage complete but no teams advanced';
        END IF;
        
    END;
    
    RAISE NOTICE '=== Swiss Advancement Complete ===';
END;
$$;

