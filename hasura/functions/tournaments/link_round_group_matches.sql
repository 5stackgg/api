-- Function to link matches within a specific round and group
-- This function handles the group-based pairing logic for a single round and group
CREATE OR REPLACE FUNCTION link_round_group_matches(
    _stage_id uuid,
    _current_round int,
    _group int,
    _path text
) RETURNS void AS $$
DECLARE
    current_round_matches uuid[];
    next_round_matches uuid[];
    current_count int;
    next_count int;
    i int;
    target_idx int;
BEGIN
    -- Collect current round matches for this group
    SELECT array_agg(tb.id ORDER BY tb.match_number ASC)
    INTO current_round_matches
    FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = _stage_id 
      AND tb.round = _current_round 
      AND tb."group" = _group
      AND COALESCE(tb.path, 'WB') = COALESCE(_path, 'WB');
    
    current_count := COALESCE(array_length(current_round_matches, 1), 0);
    
    -- Collect next round matches for this group
    SELECT array_agg(tb.id ORDER BY tb.match_number ASC)
    INTO next_round_matches
    FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = _stage_id 
      AND tb.round = _current_round + 1 
      AND tb."group" = _group
      AND COALESCE(tb.path, 'WB') = COALESCE(_path, 'WB');
    
    next_count := COALESCE(array_length(next_round_matches, 1), 0);
    
    IF next_count = 0 THEN
        RETURN; -- No next round matches in this group
    END IF;
    
    -- Distribute current round matches to next round matches within the same group
    -- WB pattern: always pair two matches into one next match
    --   e.g. Match 1,2 → next Match 1; Match 3,4 → next Match 2
    -- LB pattern:
    --   - If next round has the same number of matches as current_round (next_count >= current_count),
    --     use 1-to-1 mapping by match number (Match i → next Match i).
    --   - If next round has fewer matches than current_round (next_count < current_count),
    --     pair two matches into one next match, like WB.
    FOR i IN 1..current_count LOOP
        -- Calculate target index based on path and relative round sizes
        IF COALESCE(_path, 'WB') = 'LB' THEN
            -- Losers bracket:
            IF next_count >= current_count THEN
                -- Same or larger number of matches in next round: 1-to-1 mapping
                target_idx := i;
            ELSE
                -- Fewer matches in next round (e.g. LB Round 2 → LB Round 3 in an 8-team DE):
                -- pair two current matches into one next match
                target_idx := ((i - 1) / 2) + 1;
            END IF;
        ELSE
            -- Winners bracket: always pairing pattern (every 2 matches go to the same parent match)
            target_idx := ((i - 1) / 2) + 1;
        END IF;
        
        -- Only proceed if we have a valid target
        IF target_idx <= next_count THEN
            UPDATE tournament_brackets
            SET parent_bracket_id = next_round_matches[target_idx]
            WHERE id = current_round_matches[i];
            
            RAISE NOTICE 'Linked match (%): Round % Group % Match % -> Parent Round % Group % Match %', 
                COALESCE(_path, 'WB'), _current_round, _group, i,
                _current_round + 1, _group, target_idx;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;