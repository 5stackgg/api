-- Function to link advancing matches between consecutive tournament stages
-- This function automatically distributes top-round matches from each stage to the next stage
-- using a round-robin approach that scales to any number of groups and stages
CREATE OR REPLACE FUNCTION link_tournament_stages(_tournament_id uuid)
RETURNS void AS $$
DECLARE
    stage_record record;
    max_stage_order int;
BEGIN
    -- Calculate max stage order once outside the loop
    SELECT MAX("order") INTO max_stage_order
    FROM tournament_stages 
    WHERE tournament_id = _tournament_id;
    
    -- Get all stages with their next stage info and top rounds in one query
    FOR stage_record IN
        SELECT 
            ts1.id as current_id,
            ts1."order" as current_order,
            ts2.id as next_id,
            ts2."order" as next_order,
            COALESCE(MAX(tb.round), 0) as top_round
        FROM tournament_stages ts1
        LEFT JOIN tournament_stages ts2 ON ts2.tournament_id = _tournament_id AND ts2."order" = ts1."order" + 1
        LEFT JOIN tournament_brackets tb ON tb.tournament_stage_id = ts1.id
        WHERE ts1.tournament_id = _tournament_id 
          AND ts1."order" < max_stage_order
        GROUP BY ts1.id, ts1."order", ts2.id, ts2."order"
        ORDER BY ts1."order" ASC
    LOOP
        -- Skip if no next stage found
        IF stage_record.next_id IS NULL THEN
            CONTINUE;
        END IF;

        -- Link current stage top-round matches to next stage using helper function
        PERFORM link_stage_brackets(stage_record.current_id, stage_record.next_id, stage_record.top_round);
    END LOOP;
END;
$$ LANGUAGE plpgsql;