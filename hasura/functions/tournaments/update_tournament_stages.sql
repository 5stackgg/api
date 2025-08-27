-- Function to link advancing matches between consecutive tournament stages
-- This function automatically distributes top-round matches from each stage to the next stage
-- using a round-robin approach that scales to any number of groups and stages
CREATE OR REPLACE FUNCTION link_tournament_stages(_tournament_id uuid)
RETURNS void AS $$
DECLARE
    stage_record record;
    next_stage_record record;
    current_stage_order int;
    top_round int;
    group_count int;
BEGIN
            -- Get all stages for this tournament ordered by their sequence
        FOR stage_record IN
            SELECT id, "order"
            FROM tournament_stages 
            WHERE tournament_id = _tournament_id 
            ORDER BY "order" ASC
    LOOP
        -- Skip the last stage (no next stage to link to)
        IF stage_record."order" = (SELECT MAX("order") FROM tournament_stages WHERE tournament_id = _tournament_id) THEN
            CONTINUE;
        END IF;
        
        current_stage_order := stage_record."order";
        
        -- Get the next stage in sequence
        SELECT id, "order" INTO next_stage_record
        FROM tournament_stages 
        WHERE tournament_id = _tournament_id AND "order" = current_stage_order + 1;
        
        IF next_stage_record.id IS NULL THEN
            CONTINUE; -- No next stage found
        END IF;
        
        -- Get the top (playable) round number for the current stage
        SELECT MAX(tb.round) INTO top_round
        FROM tournament_brackets tb
        WHERE tb.tournament_stage_id = stage_record.id;

        -- Count how many groups we have in the current stage to determine distribution pattern
        SELECT COUNT(DISTINCT tb."group") INTO group_count
        FROM tournament_brackets tb
        WHERE tb.tournament_stage_id = stage_record.id AND tb.round = top_round;

        -- Link current stage top-round matches to next stage using helper function
        PERFORM link_stage_brackets(stage_record.id, next_stage_record.id, top_round);
    END LOOP;
END;
$$ LANGUAGE plpgsql;

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
    SELECT array_agg(tb.id ORDER BY tb."group" ASC, tb.match_number ASC)
    INTO current_top_ids
    FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = current_stage_id AND tb.round = top_round;

    current_count := COALESCE(array_length(current_top_ids, 1), 0);

    -- Distribute all current top-round matches evenly across next stage round-1 matches
    FOR i IN 1..current_count LOOP
        target_idx := ((i - 1) % next_count) + 1;
        UPDATE tournament_brackets
        SET parent_bracket_id = next_round1_ids[target_idx]
        WHERE id = current_top_ids[i];
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Function to show bracket counts per stage for a tournament
CREATE OR REPLACE FUNCTION show_tournament_bracket_summary(_tournament_id uuid)
RETURNS void AS $$
DECLARE
    stage_summary RECORD;
BEGIN
    FOR stage_summary IN
        SELECT 
            ts."order",
            ts.groups,
            COUNT(tb.id) as bracket_count
        FROM tournament_stages ts
        LEFT JOIN tournament_brackets tb ON ts.id = tb.tournament_stage_id
        WHERE ts.tournament_id = _tournament_id
        GROUP BY ts."order", ts.groups
        ORDER BY ts."order"
    LOOP
        RAISE NOTICE 'Stage % (groups=%): % brackets created', 
            stage_summary."order", stage_summary.groups, stage_summary.bracket_count;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Helper function to get stage max teams and effective teams for a given stage
CREATE OR REPLACE FUNCTION get_stage_team_counts(
    _tournament_id uuid,
    _stage_order int,
    _tournament_status text
) RETURNS TABLE(stage_max_teams int, effective_teams int) AS $$
BEGIN
    -- Get stage max_teams
    SELECT max_teams INTO stage_max_teams
    FROM tournament_stages
    WHERE tournament_id = _tournament_id AND "order" = _stage_order;

    -- If tournament is in Setup status, use max_teams for bracket planning
    IF _tournament_status = 'Setup' THEN
        effective_teams := stage_max_teams;
    ELSE
        IF _stage_order = 1 THEN
            SELECT COUNT(*) INTO effective_teams
                FROM tournament_teams
                WHERE tournament_id = _tournament_id AND eligible_at IS NOT NULL;
        ELSE
            -- get the number of matches from the last round of the previous stage
            SELECT COUNT(*) INTO effective_teams
            FROM tournament_brackets tb
            JOIN tournament_stages ts ON tb.tournament_stage_id = ts.id
            WHERE ts.tournament_id = _tournament_id AND ts."order" = _stage_order - 1 AND tb.round = (SELECT MAX(tb2.round) FROM tournament_brackets tb2 JOIN tournament_stages ts2 ON tb2.tournament_stage_id = ts2.id WHERE ts2.tournament_id = _tournament_id AND ts2."order" = _stage_order - 1);
        END IF;
    END IF;

    RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- Main function to update tournament stages
CREATE OR REPLACE FUNCTION update_tournament_stages(_tournament_id uuid)
RETURNS void AS $$
DECLARE
    stage RECORD;
    new_id uuid;
    stage_max_teams int;
    effective_teams int;
    tournament_status text;
    matches_in_round int;
    next_stage_max_teams int;
    total_rounds int;
    teams_left_to_assign int;
    skipped_stage_effective_teams int;
BEGIN
    -- Get tournament status for logging
    SELECT status INTO tournament_status
    FROM tournaments
    WHERE id = _tournament_id;
    
    RAISE NOTICE '=== STARTING TOURNAMENT STAGE UPDATE ===';
    RAISE NOTICE 'Tournament ID: %', _tournament_id;
    RAISE NOTICE 'Tournament Status: %', tournament_status;

    -- Delete existing brackets for all stages
    DELETE FROM tournament_brackets WHERE tournament_stage_id IN (SELECT id FROM tournament_stages WHERE tournament_id = _tournament_id);
    RAISE NOTICE 'Deleted existing brackets for all stages';

    -- Process each stage
    FOR stage IN SELECT * FROM tournament_stages ts WHERE ts.tournament_id = _tournament_id ORDER BY ts."order" LOOP
        RAISE NOTICE '--- PROCESSING STAGE % ---', stage."order";
       
        SELECT * INTO stage_max_teams, effective_teams FROM get_stage_team_counts(_tournament_id, stage."order", tournament_status);

        if(skipped_stage_effective_teams is not null) then
            effective_teams := skipped_stage_effective_teams;
            skipped_stage_effective_teams := null;
        end if;

        next_stage_max_teams := COALESCE((select max_teams from tournament_stages ts2 where ts2.tournament_id = _tournament_id and ts2."order" = stage."order" + 1), 1);
        total_rounds := GREATEST(CEIL(LOG(effective_teams::float / next_stage_max_teams) / LOG(2)), 1);

        IF effective_teams = next_stage_max_teams THEN
            RAISE NOTICE 'Stage % : effective_teams = next_stage_max_teams, skipping', stage."order";
            skipped_stage_effective_teams = effective_teams;
            CONTINUE;
        END IF;

        RAISE NOTICE 'Stage % : min_teams=%, max_teams=%, groups=%, effective_teams=%, total_rounds=%, next_stage_max=%', 
            stage."order", stage.min_teams, stage.max_teams, stage.groups, effective_teams, total_rounds, next_stage_max_teams;
        
        -- Initialize teams left to assign
        teams_left_to_assign := effective_teams;
        
        FOR round_num IN 1..total_rounds LOOP
            -- Calculate total matches needed for this round (each match needs 2 teams)
            matches_in_round := CEIL(teams_left_to_assign::numeric / 2);
            
            RAISE NOTICE '  => Process round %: teams_left_to_assign=%, total_matches_in_round=%', round_num, teams_left_to_assign, matches_in_round;

            -- Create matches alternating between groups
            FOR match_idx IN 1..matches_in_round LOOP
                -- Calculate which group this match belongs to (alternating)
                DECLARE
                    group_num int;
                BEGIN
                    group_num := ((match_idx - 1) % stage.groups) + 1;
                    
                    INSERT INTO tournament_brackets (round, tournament_stage_id, match_number, "group")
                    VALUES (round_num, stage.id, match_idx, group_num)
                    RETURNING id INTO new_id;
                    RAISE NOTICE '      => Created round % group % match %: id=%', round_num, group_num, match_idx, new_id;
                END;
            END LOOP;

            teams_left_to_assign := teams_left_to_assign / 2;
        END LOOP;
    END LOOP;

    -- Link tournament stages by calling the dedicated linking function
    -- This establishes parent-child relationships between consecutive stages
    RAISE NOTICE '--- LINKING TOURNAMENT STAGES ---';
    PERFORM link_tournament_stages(_tournament_id);

    -- Final summary
    RAISE NOTICE '=== TOURNAMENT STAGE UPDATE COMPLETE ===';
    RAISE NOTICE 'Tournament %: All stages processed successfully (status: %)', _tournament_id, tournament_status;
    
    -- Show bracket counts per stage
    PERFORM show_tournament_bracket_summary(_tournament_id);
    
    PERFORM calculate_tournament_bracket_start_times(_tournament_id);
END;
$$ LANGUAGE plpgsql;