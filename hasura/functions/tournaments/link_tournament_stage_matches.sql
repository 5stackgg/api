-- Function to link matches within a single tournament stage
-- This function connects matches in consecutive rounds within the same stage
-- Winners of round N advance to round N+1 in the same stage
CREATE OR REPLACE FUNCTION link_tournament_stage_matches(_stage_id uuid)
RETURNS void AS $$
DECLARE
    round_record record;
    group_record record;
    max_round int;
BEGIN
    -- Calculate max round once outside the loop
    SELECT MAX(round) INTO max_round
    FROM tournament_brackets 
    WHERE tournament_stage_id = _stage_id;
    
    -- Get all rounds and groups for this stage, ordered by round and group
    FOR round_record IN
        SELECT DISTINCT tb.round, tb."group"
        FROM tournament_brackets tb
        WHERE tb.tournament_stage_id = _stage_id 
        ORDER BY tb.round ASC, tb."group" ASC
    LOOP
        -- Skip the last round (no next round to link to)
        IF round_record.round = max_round THEN
            CONTINUE;
        END IF;
        
        PERFORM link_round_group_matches(_stage_id, round_record.round, round_record."group"::int);
    END LOOP;
END;
$$ LANGUAGE plpgsql;