CREATE OR REPLACE FUNCTION calculate_tournament_bracket_start_times(_tournament_id uuid) RETURNS void AS $$
DECLARE
    stage_record RECORD;
    round_record RECORD;
    bracket_record RECORD;
    base_start_time timestamptz;
    child_finish_time timestamptz;
BEGIN
    UPDATE tournament_brackets 
    SET scheduled_eta = NULL
    WHERE tournament_stage_id IN (
        SELECT id FROM tournament_stages WHERE tournament_id = _tournament_id
    );
    
    -- Get the tournament start time
    SELECT start INTO base_start_time
    FROM tournaments 
    WHERE id = _tournament_id;
    
    -- Process stages for the specific tournament
    FOR stage_record IN 
        SELECT ts."order", ts.id as tournament_stage_id, ts.type as stage_type
        FROM tournament_stages ts
        WHERE ts.tournament_id = _tournament_id 
        ORDER BY ts."order"
    LOOP
        -- For RoundRobin stages, calculate ETAs based on round number (each round +1 hour)
        IF stage_record.stage_type = 'RoundRobin' THEN
            -- Process rounds within RoundRobin stage
            FOR round_record IN 
                SELECT DISTINCT tb.round 
                FROM tournament_brackets tb
                WHERE tb.tournament_stage_id = stage_record.tournament_stage_id 
                ORDER BY tb.round
            LOOP
                -- Round 1 starts at tournament start time
                -- Each subsequent round starts 1 hour after the previous round
                DECLARE
                    round_start_time timestamptz;
                BEGIN
                    IF round_record.round = 1 THEN
                        round_start_time := base_start_time;
                    ELSE
                        -- Previous round's start time + 1 hour
                        round_start_time := base_start_time + ((round_record.round - 1) * interval '1 hour');
                    END IF;
                    
                    -- Update all brackets in this round
                    UPDATE tournament_brackets 
                    SET scheduled_eta = CASE 
                        -- If bracket has a match, use its actual start time
                        WHEN match_id IS NOT NULL THEN (
                            SELECT COALESCE(m.started_at, m.scheduled_at)
                            FROM matches m
                            WHERE m.id = tournament_brackets.match_id
                        )
                        -- Otherwise use the calculated round start time
                        ELSE round_start_time
                    END
                    WHERE tournament_stage_id = stage_record.tournament_stage_id 
                      AND round = round_record.round;
                END;
            END LOOP;
        ELSIF stage_record.stage_type = 'Swiss' THEN
            -- For Swiss stages: find latest finished round, then calculate based on round difference
            DECLARE
                latest_finished_round int;
                latest_finished_round_time timestamptz;
                swiss_base_start_time timestamptz;
            BEGIN
                -- Find the latest round that has finished
                SELECT MAX(tb.round)
                INTO latest_finished_round
                FROM tournament_brackets tb
                WHERE tb.tournament_stage_id = stage_record.tournament_stage_id
                  AND tb.finished = true;
                
                -- Get the finish time of the latest finished round
                IF latest_finished_round IS NOT NULL THEN
                    SELECT MAX(COALESCE(m.ended_at, m.started_at + interval '1 hour'))
                    INTO latest_finished_round_time
                    FROM tournament_brackets tb
                    INNER JOIN matches m ON m.id = tb.match_id
                    WHERE tb.tournament_stage_id = stage_record.tournament_stage_id
                      AND tb.round = latest_finished_round
                      AND m.id IS NOT NULL;
                END IF;
                
                -- Get base start time (earliest match start or tournament start)
                SELECT MIN(COALESCE(m.started_at, m.scheduled_at))
                INTO swiss_base_start_time
                FROM tournament_brackets tb
                INNER JOIN matches m ON m.id = tb.match_id
                WHERE tb.tournament_stage_id = stage_record.tournament_stage_id
                  AND (m.started_at IS NOT NULL OR (m.scheduled_at IS NOT NULL AND m.scheduled_at <= now()));
                
                IF swiss_base_start_time IS NULL THEN
                    swiss_base_start_time := base_start_time;
                END IF;
                
                FOR round_record IN 
                    SELECT DISTINCT tb.round 
                    FROM tournament_brackets tb
                    WHERE tb.tournament_stage_id = stage_record.tournament_stage_id 
                    ORDER BY tb.round
                LOOP
                    DECLARE
                        round_start_time timestamptz;
                        round_diff int;
                    BEGIN
                        -- If we have a finished round, calculate from its finish time
                        IF latest_finished_round IS NOT NULL AND latest_finished_round_time IS NOT NULL AND round_record.round > latest_finished_round THEN
                            round_diff := round_record.round - latest_finished_round - 1;
                            round_start_time := latest_finished_round_time + (round_diff * interval '1 hour');
                        ELSE
                            -- No finished rounds yet, use base calculation (round * 1 hour)
                            round_start_time := swiss_base_start_time + (round_record.round * interval '1 hour');
                        END IF;
                    
                    -- Update all brackets in this round
                    UPDATE tournament_brackets 
                    SET scheduled_eta = CASE 
                        -- If bracket has a match, use its actual start time
                        WHEN match_id IS NOT NULL THEN (
                            SELECT COALESCE(m.started_at, m.scheduled_at)
                            FROM matches m
                            WHERE m.id = tournament_brackets.match_id
                        )
                        -- Otherwise use the calculated round start time
                        ELSE round_start_time
                    END
                    WHERE tournament_stage_id = stage_record.tournament_stage_id 
                      AND round = round_record.round;
                    END;
                END LOOP;
            END;
        ELSE
            -- For elimination brackets, use the existing logic (parent bracket based)
            FOR round_record IN 
                SELECT DISTINCT tb.round 
                FROM tournament_brackets tb
                WHERE tb.tournament_stage_id = stage_record.tournament_stage_id 
                ORDER BY tb.round
            LOOP
                -- Process all brackets in this specific round
                FOR bracket_record IN 
                    SELECT * FROM tournament_brackets 
                    WHERE tournament_stage_id = stage_record.tournament_stage_id 
                    AND round = round_record.round
                    ORDER BY match_number
                LOOP
                    -- Case A: If bracket has a match, use its actual start time
                    IF bracket_record.match_id IS NOT NULL THEN
                        UPDATE tournament_brackets 
                        SET scheduled_eta = (
                            SELECT COALESCE(m.started_at, m.scheduled_at)
                            FROM matches m
                            WHERE m.id = bracket_record.match_id
                        )
                        WHERE id = bracket_record.id;
                    ELSE
                        -- Case B: Check if this bracket has children
                        SELECT MAX(child.scheduled_eta + interval '1 hour') INTO child_finish_time
                        FROM tournament_brackets child
                        WHERE child.parent_bracket_id = bracket_record.id;
                        
                        IF child_finish_time IS NOT NULL THEN
                            -- Use children completion time + 1 hour
                            UPDATE tournament_brackets 
                            SET scheduled_eta = child_finish_time
                            WHERE id = bracket_record.id;
                        ELSE
                            -- Case C: No children, use tournament start time
                            UPDATE tournament_brackets 
                            SET scheduled_eta = base_start_time
                            WHERE id = bracket_record.id;
                        END IF;
                    END IF;
                END LOOP;
            END LOOP;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION tournament_bracket_eta(bracket tournament_brackets) returns timestamptz as $$
DECLARE
    bracket_start_time timestamptz;
BEGIN
    IF bracket.scheduled_eta IS NOT NULL THEN
        RETURN bracket.scheduled_eta;
    END IF;
    
    RETURN (
        SELECT t.start 
        FROM tournaments t
        INNER JOIN tournament_stages ts ON ts.id = bracket.tournament_stage_id
        WHERE ts.id = bracket.tournament_stage_id
    );
END;
$$ language plpgsql STABLE;