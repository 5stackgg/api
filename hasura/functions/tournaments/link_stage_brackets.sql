-- RoundRobin stages advance teams based on standings, not bracket results
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
    wb_match_ids uuid[];
    lb_match_ids uuid[];
    gf_match_ids uuid[];
    interleaved_ids uuid[];
    wb_count int;
    lb_count int;
    gf_count int;
    max_matches int;
    j int;
    match_info text;
    current_stage_type text;
BEGIN
    SELECT ts.type INTO current_stage_type
    FROM tournament_stages ts
    WHERE ts.id = current_stage_id;
    
    IF current_stage_type = 'RoundRobin' THEN
        RETURN;
    END IF;
    
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
    -- Collect WB and LB matches separately so we can interleave them
    -- Collect matches by path
    SELECT array_agg(tb.id ORDER BY tb."group" ASC, tb.match_number ASC)
    INTO wb_match_ids
    FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = current_stage_id 
      AND tb.round = top_round
      AND COALESCE(tb.path, 'WB') = 'WB'
      AND (
          tb.path IS NULL 
          OR tb.round = (
              SELECT MAX(tb2.round) 
              FROM tournament_brackets tb2 
              WHERE tb2.tournament_stage_id = current_stage_id 
                AND COALESCE(tb2.path, 'WB') = 'WB'
                AND tb2."group" = tb."group"
          )
      );

    SELECT array_agg(tb.id ORDER BY tb."group" ASC, tb.match_number ASC)
    INTO lb_match_ids
    FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = current_stage_id 
      AND tb.round = top_round
      AND tb.path = 'LB'
      AND tb.round = (
          SELECT MAX(tb2.round) 
          FROM tournament_brackets tb2 
          WHERE tb2.tournament_stage_id = current_stage_id 
            AND tb2.path = 'LB'
            AND tb2."group" = tb."group"
      );

    SELECT array_agg(tb.id ORDER BY tb."group" ASC, tb.match_number ASC)
    INTO gf_match_ids
    FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = current_stage_id 
      AND tb.round = top_round
      AND tb.path = 'GF';

    wb_count := COALESCE(array_length(wb_match_ids, 1), 0);
    lb_count := COALESCE(array_length(lb_match_ids, 1), 0);
    gf_count := COALESCE(array_length(gf_match_ids, 1), 0);
    max_matches := GREATEST(wb_count, lb_count);

    -- Interleave WB and LB matches: WB1, LB1, WB2, LB2, etc.
    interleaved_ids := ARRAY[]::uuid[];
    FOR j IN 1..max_matches LOOP
        IF j <= wb_count THEN
            interleaved_ids := interleaved_ids || wb_match_ids[j];
        END IF;
        IF j <= lb_count THEN
            interleaved_ids := interleaved_ids || lb_match_ids[j];
        END IF;
    END LOOP;

    -- Add GF matches at the end
    IF gf_count > 0 THEN
        interleaved_ids := interleaved_ids || gf_match_ids;
    END IF;

    current_top_ids := interleaved_ids;
    current_count := COALESCE(array_length(current_top_ids, 1), 0);

    -- Debug: show which matches are being linked
    SELECT string_agg(tb.path || ' R' || tb.round || ' M' || tb.match_number, ', ' ORDER BY array_position(current_top_ids, tb.id))
    INTO match_info
    FROM tournament_brackets tb
    WHERE tb.id = ANY(current_top_ids);
    
    RAISE NOTICE 'Linking stage: top_round=%, current_count=% matches being linked (%)', 
        top_round, current_count, match_info;

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