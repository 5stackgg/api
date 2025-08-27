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
        SELECT ts."order", ts.id as tournament_stage_id
        FROM tournament_stages ts
        WHERE ts.tournament_id = _tournament_id 
        ORDER BY ts."order"
    LOOP
        -- Process rounds within each stage
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