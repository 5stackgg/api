CREATE OR REPLACE FUNCTION update_tournament_stages(_tournament_id uuid)
RETURNS void AS $$
DECLARE
    stage RECORD;
    new_id uuid;
    stage_max_teams int;
    effective_teams int;
    tournament_status text;
    matches_in_round int;
    teams_per_group int;
    next_stage_max_teams int;
    total_rounds int;
    teams_left_to_assign int;
    skipped_stage_effective_teams int;
    bracket_order int[];
    bracket_idx int;
    seed_1 int;
    seed_2 int;
    stage_target_size int;
BEGIN
    -- Get tournament status for logging
    SELECT status INTO tournament_status
    FROM tournaments
    WHERE id = _tournament_id;
    
    RAISE NOTICE '=== STARTING TOURNAMENT STAGE UPDATE ===';
    RAISE NOTICE 'Tournament ID: %', _tournament_id;
    RAISE NOTICE 'Tournament Status: %', tournament_status;

    PERFORM delete_tournament_brackets_and_matches(_tournament_id);

    -- Process each stage
    FOR stage IN SELECT * FROM tournament_stages ts WHERE ts.tournament_id = _tournament_id ORDER BY ts."order" LOOP
        RAISE NOTICE '--- PROCESSING STAGE % ---', stage."order";
       
        SELECT * INTO stage_max_teams, effective_teams FROM get_stage_team_counts(_tournament_id, stage."order", tournament_status);

        if(skipped_stage_effective_teams is not null) then
            effective_teams := skipped_stage_effective_teams;
            skipped_stage_effective_teams := null;
        end if;

        next_stage_max_teams := COALESCE((select max_teams from tournament_stages ts2 where ts2.tournament_id = _tournament_id and ts2."order" = stage."order" + 1), 1);
        teams_per_group := CEIL(effective_teams::float / stage.groups);
        total_rounds := GREATEST(CEIL(LOG(teams_per_group::float / CEIL(next_stage_max_teams::float / stage.groups)) / LOG(2)), 1);
        
        -- Ensure round 1 has full bracket count based on next power-of-2 per group
        stage_target_size := POWER(2, CEIL(LOG(teams_per_group::numeric) / LOG(2)))::int;

        IF effective_teams = next_stage_max_teams THEN
            RAISE NOTICE 'Stage % : effective_teams = next_stage_max_teams, skipping', stage."order";
            skipped_stage_effective_teams = effective_teams;
            CONTINUE;
        END IF;

        RAISE NOTICE 'Stage % : min_teams=%, max_teams=%, groups=%, effective_teams=%, teams_per_group=%, total_rounds=%, next_stage_max=%', 
            stage."order", stage.min_teams, stage.max_teams, stage.groups, effective_teams, teams_per_group, total_rounds, next_stage_max_teams;
                
        -- Initialize teams left to assign
        teams_left_to_assign := effective_teams;
        
        -- Generate bracket order for first round to set seed positions
        -- This applies to all stages' first rounds
        bracket_order := generate_bracket_order(effective_teams);
        RAISE NOTICE 'Generated bracket order for stage % with % teams: % (array_length: %)', 
            stage."order", effective_teams, bracket_order, array_length(bracket_order, 1);
        
        FOR round_num IN 1..total_rounds LOOP
            -- Calculate total matches needed for this round (each match needs 2 teams)
            IF round_num = 1 THEN
                -- Create full set of first-round matches across all groups (including byes)
                matches_in_round := stage.groups * (stage_target_size / 2);
            ELSE
                matches_in_round := CEIL(teams_left_to_assign::numeric / 2);
            END IF;
            
            RAISE NOTICE '  => Process round %: teams_left_to_assign=%, total_matches_in_round=%', round_num, teams_left_to_assign, matches_in_round;

            -- Reset bracket index for first round to track seed positions
            IF round_num = 1 THEN
                bracket_idx := 0;
                RAISE NOTICE '  => Round 1: Reset bracket_idx to 0, bracket_order length: %', array_length(bracket_order, 1);
            END IF;

            -- Create matches alternating between groups
            FOR match_idx IN 1..matches_in_round LOOP

                if(round_num = total_rounds and teams_left_to_assign <= 1) then
                    RAISE NOTICE '  => Skipping match %: teams_left_to_assign=%', match_idx, teams_left_to_assign;
                    CONTINUE;
                end if;

                -- Calculate which group this match belongs to (alternating)
                DECLARE
                    group_num int;
                BEGIN
                    group_num := ((match_idx - 1) % stage.groups) + 1;
                    
                    -- For first round: set seed positions based on bracket order
                    IF round_num = 1 THEN
                        -- Get seed positions from bracket order (1-based array indexing)
                        IF bracket_order IS NOT NULL AND bracket_idx * 2 + 1 <= array_length(bracket_order, 1) THEN
                            seed_1 := bracket_order[bracket_idx * 2 + 1];
                        ELSE
                            seed_1 := NULL;
                        END IF;
                        
                        IF bracket_order IS NOT NULL AND bracket_idx * 2 + 2 <= array_length(bracket_order, 1) THEN
                            seed_2 := bracket_order[bracket_idx * 2 + 2];
                        ELSE
                            seed_2 := NULL;
                        END IF;
                        
                        -- Set to NULL if seed position is beyond effective_teams (for byes)
                        IF seed_1 IS NOT NULL AND seed_1 > effective_teams THEN
                            seed_1 := NULL;
                        END IF;
                        IF seed_2 IS NOT NULL AND seed_2 > effective_teams THEN
                            seed_2 := NULL;
                        END IF;
                        
                        INSERT INTO tournament_brackets (round, tournament_stage_id, match_number, "group", team_1_seed, team_2_seed)
                        VALUES (round_num, stage.id, match_idx, group_num, seed_1, seed_2)
                        RETURNING id INTO new_id;
                        
                        RAISE NOTICE '      => Created round % group % match %: id=%, seeds: % vs % (effective_teams: %, bracket_idx: %)', 
                            round_num, group_num, match_idx, new_id, seed_1, seed_2, effective_teams, bracket_idx;
                        
                        bracket_idx := bracket_idx + 1;
                    ELSE
                        -- For other rounds: no seed positions yet (will be set when teams advance)
                        INSERT INTO tournament_brackets (round, tournament_stage_id, match_number, "group")
                        VALUES (round_num, stage.id, match_idx, group_num)
                        RETURNING id INTO new_id;
                        RAISE NOTICE '      => Created round % group % match %: id=%', round_num, group_num, match_idx, new_id;
                    END IF;
                END;
                teams_left_to_assign := teams_left_to_assign - 2;
            END LOOP;

            -- Calculate teams advancing to next round: each match produces 1 winner
            teams_left_to_assign := matches_in_round;
        END LOOP;
        RAISE NOTICE '  => Linking matches within stage %', stage."order";
        PERFORM link_tournament_stage_matches(stage.id);
    END LOOP;

    RAISE NOTICE '--- LINKING TOURNAMENT STAGES ---';
    PERFORM link_tournament_stages(_tournament_id);

    RAISE NOTICE '=== TOURNAMENT STAGE UPDATE COMPLETE ===';
    
    PERFORM calculate_tournament_bracket_start_times(_tournament_id);
END;
$$ LANGUAGE plpgsql;