-- Connects matches in consecutive rounds within the same stage
-- Winners of round N advance to round N+1 in the same stage
-- Note: RoundRobin stages don't have parent brackets (all matches are independent)
CREATE OR REPLACE FUNCTION link_tournament_stage_matches(_stage_id uuid)
RETURNS void AS $$
DECLARE
    round_record record;
    group_record record;
    path_record record;
    max_round int;
    stage_type text;
BEGIN
    SELECT ts.type INTO stage_type
    FROM tournament_stages ts
    WHERE ts.id = _stage_id;
    
    IF stage_type = 'RoundRobin' THEN
        RETURN;
    END IF;
    
    -- For each path within the stage, link rounds within that path
    FOR path_record IN
        SELECT DISTINCT COALESCE(path, 'WB') AS path
        FROM tournament_brackets
        WHERE tournament_stage_id = _stage_id
    LOOP
        -- Calculate max round per path
        SELECT MAX(round) INTO max_round
        FROM tournament_brackets 
        WHERE tournament_stage_id = _stage_id
          AND COALESCE(path, 'WB') = path_record.path;

        -- Get all rounds and groups for this stage and path
        FOR round_record IN
            SELECT DISTINCT tb.round, tb."group"
            FROM tournament_brackets tb
            WHERE tb.tournament_stage_id = _stage_id 
              AND COALESCE(tb.path, 'WB') = path_record.path
            ORDER BY tb.round ASC, tb."group" ASC
        LOOP
            -- Skip the last round (no next round to link to)
            IF round_record.round = max_round THEN
                CONTINUE;
            END IF;
            
            PERFORM link_round_group_matches(_stage_id, round_record.round, round_record."group"::int, path_record.path);
        END LOOP;
    END LOOP;
END;
$$ LANGUAGE plpgsql;