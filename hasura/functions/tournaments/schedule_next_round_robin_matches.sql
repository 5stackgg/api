-- Called when a RoundRobin match finishes to check if next round matches can be scheduled
CREATE OR REPLACE FUNCTION public.schedule_next_round_robin_matches(_finished_bracket_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    finished_bracket RECORD;
    team_1_id uuid;
    team_2_id uuid;
    current_round int;
    current_group int;
    stage_id uuid;
    next_round int;
    team_1_next_bracket_id uuid;
    team_1_next_bracket tournament_brackets%ROWTYPE;
    team_1_opponent_id uuid;
    team_2_next_bracket_id uuid;
    team_2_next_bracket tournament_brackets%ROWTYPE;
    team_2_opponent_id uuid;
    brackets_to_schedule uuid[];
    bracket_id uuid;
    bracket_row tournament_brackets%ROWTYPE;
BEGIN
    -- Get the finished bracket info
    SELECT tb.*, ts.id as stage_id, ts.type as stage_type
    INTO finished_bracket
    FROM tournament_brackets tb
    JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
    WHERE tb.id = _finished_bracket_id;
    
    IF finished_bracket IS NULL OR finished_bracket.stage_type != 'RoundRobin' THEN
        RETURN;
    END IF;
    
    current_round := finished_bracket.round;
    current_group := finished_bracket."group";
    stage_id := finished_bracket.stage_id;
    team_1_id := finished_bracket.tournament_team_id_1;
    team_2_id := finished_bracket.tournament_team_id_2;
    next_round := current_round + 1;
    
    -- Check if there's a next round
    IF NOT EXISTS (
        SELECT 1 FROM tournament_brackets 
        WHERE tournament_stage_id = stage_id 
          AND round = next_round 
          AND "group" = current_group
    ) THEN
        RETURN;
    END IF;
    
    brackets_to_schedule := ARRAY[]::uuid[];
    
    -- Process team_1
    IF team_1_id IS NOT NULL THEN
        team_1_next_bracket_id := get_team_next_round_bracket_id(team_1_id, stage_id, current_round, current_group);
        
        IF team_1_next_bracket_id IS NOT NULL THEN
            SELECT * INTO team_1_next_bracket FROM tournament_brackets WHERE id = team_1_next_bracket_id;
            
            -- Get opponent
            team_1_opponent_id := CASE 
                WHEN team_1_next_bracket.tournament_team_id_1 = team_1_id 
                THEN team_1_next_bracket.tournament_team_id_2 
                ELSE team_1_next_bracket.tournament_team_id_1 
            END;
            
            -- Check if opponent finished and add to schedule list
            IF team_1_opponent_id IS NOT NULL AND 
               opponent_finished_previous_round(team_1_opponent_id, stage_id, current_round, current_group) THEN
                brackets_to_schedule := brackets_to_schedule || team_1_next_bracket_id;
            END IF;
        END IF;
    END IF;
    
    -- Process team_2
    IF team_2_id IS NOT NULL THEN
        team_2_next_bracket_id := get_team_next_round_bracket_id(team_2_id, stage_id, current_round, current_group);
        
        IF team_2_next_bracket_id IS NOT NULL THEN
            SELECT * INTO team_2_next_bracket FROM tournament_brackets WHERE id = team_2_next_bracket_id;
            
            -- Get opponent
            team_2_opponent_id := CASE 
                WHEN team_2_next_bracket.tournament_team_id_1 = team_2_id 
                THEN team_2_next_bracket.tournament_team_id_2 
                ELSE team_2_next_bracket.tournament_team_id_1 
            END;
            
            -- Check if opponent finished and add to schedule list (avoid duplicates)
            IF team_2_opponent_id IS NOT NULL AND 
               opponent_finished_previous_round(team_2_opponent_id, stage_id, current_round, current_group) AND
               NOT (team_2_next_bracket_id = ANY(brackets_to_schedule)) THEN
                brackets_to_schedule := brackets_to_schedule || team_2_next_bracket_id;
            END IF;
        END IF;
    END IF;
    
    -- Schedule all brackets that are ready
    IF array_length(brackets_to_schedule, 1) > 0 THEN
        FOREACH bracket_id IN ARRAY brackets_to_schedule LOOP
            SELECT * INTO bracket_row FROM tournament_brackets WHERE id = bracket_id;
            
            IF bracket_row.match_id IS NULL THEN
                PERFORM schedule_tournament_match(bracket_row);
            END IF;
        END LOOP;
    END IF;
END;
$$;
