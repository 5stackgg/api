-- Function to link matches within a specific round and group
-- This function handles the group-based pairing logic for a single round and group
CREATE OR REPLACE FUNCTION link_round_group_matches(
    _stage_id uuid,
    _current_round int,
    _group int
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
      AND tb."group" = _group;
    
    current_count := COALESCE(array_length(current_round_matches, 1), 0);
    
    -- Collect next round matches for this group
    SELECT array_agg(tb.id ORDER BY tb.match_number ASC)
    INTO next_round_matches
    FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = _stage_id 
      AND tb.round = _current_round + 1 
      AND tb."group" = _group;
    
    next_count := COALESCE(array_length(next_round_matches, 1), 0);
    
    IF next_count = 0 THEN
        RETURN; -- No next round matches in this group
    END IF;
    
    -- Distribute current round matches to next round matches within the same group
    -- Each pair of matches in current round links to one match in next round
    FOR i IN 1..current_count LOOP
        -- Calculate target index: every 2 matches go to the same parent match
        target_idx := ((i - 1) / 2) + 1;
        
        -- Only proceed if we have a valid target
        IF target_idx <= next_count THEN
            UPDATE tournament_brackets
            SET parent_bracket_id = next_round_matches[target_idx]
            WHERE id = current_round_matches[i];
            
            RAISE NOTICE 'Linked match: Round % Group % Match % -> Parent Round % Group % Match %', 
                _current_round, _group, i,
                _current_round + 1, _group, target_idx;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;