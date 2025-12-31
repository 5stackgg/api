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

    -- Handle first round byes: update parent matches with seeds, then delete bye matches
    DECLARE
        bye_match record;
        bye_seed int;
        first_child_match_number int;
    BEGIN
        FOR bye_match IN
            SELECT tb.id, tb.match_number, tb."group", tb.parent_bracket_id,
                   tb.team_1_seed, tb.team_2_seed, COALESCE(tb.path, 'WB') AS path
            FROM tournament_brackets tb
            WHERE tb.tournament_stage_id = _stage_id
              AND tb.round = 1
              AND (tb.team_1_seed IS NULL OR tb.team_2_seed IS NULL)
        LOOP
            -- Get the seed from the bye match (the non-NULL one)
            bye_seed := COALESCE(bye_match.team_1_seed, bye_match.team_2_seed);
            
            -- Skip if no parent or no seed
            IF bye_match.parent_bracket_id IS NULL OR bye_seed IS NULL THEN
                CONTINUE;
            END IF;
            
            -- Determine which slot in the parent match to populate
            -- Find the lowest match_number among all children of the parent (same group and path)
            SELECT MIN(tb2.match_number) INTO first_child_match_number
            FROM tournament_brackets tb2
            WHERE tb2.parent_bracket_id = bye_match.parent_bracket_id
              AND tb2.round = 1
              AND tb2."group" = bye_match."group"
              AND COALESCE(tb2.path, 'WB') = bye_match.path;
            
            -- If this bye match has the lowest match_number, populate team_1_seed
            -- Otherwise, populate team_2_seed
            -- Only populate if the slot is empty
            IF bye_match.match_number = first_child_match_number THEN
                UPDATE tournament_brackets
                SET team_1_seed = bye_seed
                WHERE id = bye_match.parent_bracket_id
                  AND team_1_seed IS NULL;
            ELSE
                UPDATE tournament_brackets
                SET team_2_seed = bye_seed
                WHERE id = bye_match.parent_bracket_id
                  AND team_2_seed IS NULL;
            END IF;
            
            RAISE NOTICE '  Advanced seed % from bye match % (round 1, match %) to parent match %', 
                bye_seed, bye_match.id, bye_match.match_number, bye_match.parent_bracket_id;
        END LOOP;
        
        -- Now delete the bye matches
        DELETE FROM tournament_brackets
        WHERE tournament_stage_id = _stage_id
          AND round = 1
          AND (team_1_seed IS NULL OR team_2_seed IS NULL);
    END;

END;
$$ LANGUAGE plpgsql;