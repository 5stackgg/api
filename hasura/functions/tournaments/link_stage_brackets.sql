-- Function to link brackets between two consecutive tournament stages
CREATE OR REPLACE FUNCTION link_stage_brackets(
    current_stage_id uuid, 
    next_stage_id uuid, 
    top_round int
) RETURNS void AS $$
DECLARE
    next_round1_ids uuid[];
    current_top_ids uuid[];
    next_count int;
    current_count int;
    i int;
    target_idx int;
BEGIN
    -- Collect next stage round-1 matches in order
    SELECT array_agg(tb.id ORDER BY tb.match_number ASC)
    INTO next_round1_ids
    FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = next_stage_id AND tb.round = 1;

    next_count := COALESCE(array_length(next_round1_ids, 1), 0);

    IF next_count = 0 THEN
        RETURN; -- nothing to link to
    END IF;

    -- Collect all top-round matches from the current stage across all groups
    -- For double elimination, we want to link final matches (highest round per path)
    -- This ensures we only link WB final, LB final, and GF (if exists), not all matches from max round
    SELECT array_agg(tb.id ORDER BY tb."group" ASC, tb.match_number ASC)
    INTO current_top_ids
    FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = current_stage_id 
      AND tb.round = top_round
      AND (
          -- Link if it's the highest round for this path, or if path is NULL (single elim)
          tb.path IS NULL 
          OR tb.round = (
              SELECT MAX(tb2.round) 
              FROM tournament_brackets tb2 
              WHERE tb2.tournament_stage_id = current_stage_id 
                AND COALESCE(tb2.path, 'WB') = COALESCE(tb.path, 'WB')
                AND tb2."group" = tb."group"
          )
      );

    current_count := COALESCE(array_length(current_top_ids, 1), 0);

    -- Debug: show which matches are being linked and all matches at top_round
    DECLARE
        match_info text;
        all_matches_info text;
    BEGIN
        SELECT string_agg(tb.path || ' R' || tb.round || ' M' || tb.match_number, ', ' ORDER BY tb."group", tb.match_number)
        INTO match_info
        FROM tournament_brackets tb
        WHERE tb.id = ANY(current_top_ids);
        
        SELECT string_agg(tb.path || ' R' || tb.round || ' M' || tb.match_number, ', ' ORDER BY tb."group", tb.match_number)
        INTO all_matches_info
        FROM tournament_brackets tb
        WHERE tb.tournament_stage_id = current_stage_id AND tb.round = top_round;
        
        RAISE NOTICE 'Linking stage: top_round=%, current_count=% matches being linked (%), all matches at round %: (%)', 
            top_round, current_count, match_info, top_round, all_matches_info;
    END;

    -- Distribute all current top-round matches evenly across next stage round-1 matches
    FOR i IN 1..current_count LOOP
        target_idx := ((i - 1) % next_count) + 1;
        UPDATE tournament_brackets
        SET parent_bracket_id = next_round1_ids[target_idx]
        WHERE id = current_top_ids[i];
        RAISE NOTICE '  Linked match % to next stage match %', i, target_idx;
    END LOOP;
END;
$$ LANGUAGE plpgsql;