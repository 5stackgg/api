CREATE OR REPLACE FUNCTION update_tournament_stages(_tournament_id uuid)
RETURNS void AS $$
DECLARE
    stage RECORD;
    new_id uuid;
    stage_type text;
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

        stage_type := stage.type;

        if(skipped_stage_effective_teams is not null) then
            effective_teams := skipped_stage_effective_teams;
            skipped_stage_effective_teams := null;
        end if;

        next_stage_max_teams := COALESCE((select max_teams from tournament_stages ts2 where ts2.tournament_id = _tournament_id and ts2."order" = stage."order" + 1), 1);

        RAISE NOTICE 'Stage % : effective_teams=%, next_stage_max_teams=%, groups=%', stage."order", effective_teams, next_stage_max_teams, stage.groups;
        teams_per_group := CEIL(effective_teams::float / stage.groups); 
        
        IF stage_type = 'RoundRobin' THEN
            RAISE NOTICE 'Stage % : RoundRobin detected', stage."order";
            
            -- For round robin, we generate all pairings
            -- Each group needs (teams_per_group * (teams_per_group - 1)) / 2 matches total
            -- We organize them into rounds for scheduling
            -- For N teams: N-1 rounds if N is even, N rounds if N is odd
            -- Each round has floor(N/2) matches
            
            DECLARE
                g int;
                team_seeds int[];
                total_matches_per_group int;
                matches_per_round int;
                round_count int;
                match_counter int;
                i int;
                j int;
                round_num int;
                team_1_seed int;
                team_2_seed int;
            BEGIN
                total_matches_per_group := (teams_per_group * (teams_per_group - 1)) / 2;
                
                -- Calculate rounds: N-1 rounds if even, N rounds if odd (to handle bye if odd)
                IF teams_per_group % 2 = 0 THEN
                    round_count := teams_per_group - 1;
                    matches_per_round := teams_per_group / 2;
                ELSE
                    round_count := teams_per_group;
                    matches_per_round := (teams_per_group - 1) / 2;
                END IF;
                
                RAISE NOTICE '  => RoundRobin: total_matches_per_group=%, round_count=%, matches_per_round=%', 
                    total_matches_per_group, round_count, matches_per_round;
                
                -- Generate round robin matches for each group
                -- Distribute seeds evenly across groups using round-robin pattern:
                -- Group 1: seeds 1, 1+groups, 1+2*groups, ...
                -- Group 2: seeds 2, 2+groups, 2+2*groups, ...
                -- etc.
                FOR g IN 1..stage.groups LOOP
                    RAISE NOTICE '  => Generating RoundRobin matches for group %', g;
                    
                    -- Calculate which seeds belong to this group using round-robin distribution
                    DECLARE
                        team_seeds int[];
                        seed_val int;
                        round_num int;
                    BEGIN
                        team_seeds := ARRAY[]::int[];
                        round_num := 0;
                        
                        -- Loop through rounds, assigning seeds: g, g+groups, g+2*groups, ...
                        LOOP
                            seed_val := g + round_num * stage.groups;
                            
                            -- Stop if seed exceeds effective_teams
                            IF seed_val > effective_teams THEN
                                EXIT;
                            END IF;
                            
                            team_seeds := team_seeds || seed_val;
                            round_num := round_num + 1;
                        END LOOP;
                        
                        IF array_length(team_seeds, 1) < 2 THEN
                            RAISE NOTICE '  => Skipping group %: only % teams (need at least 2)', 
                                g, COALESCE(array_length(team_seeds, 1), 0);
                            CONTINUE;
                        END IF;
                        
                        RAISE NOTICE '  => Group %: % teams (seeds: %)', 
                            g, array_length(team_seeds, 1), team_seeds;
                        
                        -- Use reusable function to create all round robin matches with seeds
                        -- Teams will be assigned later in seed_tournament
                        PERFORM create_round_robin_matches(
                            stage.id,
                            g,
                            1,  -- Start at round 1
                            NULL,  -- team_ids
                            team_seeds,  -- team_seeds
                            false  -- Don't schedule yet, teams not assigned
                        );
                    END;
                END LOOP;
            END;
            
            CONTINUE;
        END IF;
        
        -- For Swiss tournaments, generate entire bracket upfront with all rounds and pools
        IF stage_type = 'Swiss' THEN
            RAISE NOTICE 'Stage % : Swiss detected, generating entire bracket', stage."order";
            
            -- First round requires even number (all teams start at 0-0, same pool)
            IF effective_teams % 2 != 0 THEN
                RAISE EXCEPTION 'Swiss tournament first round must have an even number of teams. Current: %', effective_teams USING ERRCODE = '22000';
            END IF;
            
            PERFORM generate_swiss_bracket(stage.id, effective_teams);
            
            CONTINUE;
        END IF;
        
        -- For double elimination, calculate rounds based on teams needed
        -- Standard double elim produces 2 teams (WB champion + LB champion)
        -- If we need more than 2, we stop earlier to get more teams from earlier rounds
        IF stage_type = 'DoubleElimination' THEN
            DECLARE
                teams_needed_per_group int;
                wb_teams_needed int;
            BEGIN
                teams_needed_per_group := CEIL(next_stage_max_teams::float / stage.groups);
                
                -- If we need 2 or fewer teams per group, use full bracket (standard double elim)
                -- The full bracket ensures proper double elimination structure
                -- For 4 teams → 2 teams: full bracket gives us WB final (1 winner) + LB final (1 winner) = 2 teams
                IF teams_needed_per_group <= 2 THEN
                    -- Full bracket: all rounds needed for complete double elimination
                    -- For N teams, we need LOG2(N) rounds to get to the final
                    total_rounds := CEIL(LOG(teams_per_group::numeric) / LOG(2));
                    RAISE NOTICE 'Stage % : DoubleElimination detected, teams_needed_per_group=% (standard), creating full bracket with % rounds', 
                        stage."order", teams_needed_per_group, total_rounds;
                ELSE
                    -- Calculate rounds based on teams needed (more than 2)
                    -- Winners have priority, so calculate how many we need from WB
                    wb_teams_needed := CEIL(teams_needed_per_group::float / 2);
                    -- Calculate rounds: teams_per_group / (2^rounds) = wb_teams_needed
                    total_rounds := GREATEST(CEIL(LOG(teams_per_group::numeric / wb_teams_needed) / LOG(2)), 1);
                    RAISE NOTICE 'Stage % : DoubleElimination detected, teams_needed_per_group=%, wb_teams_needed=%, creating bracket with % rounds', 
                        stage."order", teams_needed_per_group, wb_teams_needed, total_rounds;
                END IF;
            END;
        ELSE
            total_rounds := GREATEST(CEIL(LOG(teams_per_group::float / CEIL(next_stage_max_teams::float / stage.groups)) / LOG(2)), 1);
        END IF;
        
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
                        
                        INSERT INTO tournament_brackets (round, tournament_stage_id, match_number, "group", team_1_seed, team_2_seed, path)
                        VALUES (round_num, stage.id, match_idx, group_num, seed_1, seed_2, 'WB')
                        RETURNING id INTO new_id;
                        
                        RAISE NOTICE '      => Created round % group % match %: id=%, seeds: % vs % (effective_teams: %, bracket_idx: %)', 
                            round_num, group_num, match_idx, new_id, seed_1, seed_2, effective_teams, bracket_idx;
                        
                        bracket_idx := bracket_idx + 1;
                    ELSE
                        -- For other rounds: no seed positions yet (will be set when teams advance)
                        INSERT INTO tournament_brackets (round, tournament_stage_id, match_number, "group", path)
                        VALUES (round_num, stage.id, match_idx, group_num, 'WB')
                        RETURNING id INTO new_id;
                        RAISE NOTICE '      => Created round % group % match %: id=%', round_num, group_num, match_idx, new_id;
                    END IF;
                END;
                teams_left_to_assign := teams_left_to_assign - 2;
            END LOOP;

            -- Calculate teams advancing to next round: each match produces 1 winner
            teams_left_to_assign := matches_in_round;
        END LOOP;

        -- If DoubleElimination, generate losers bracket and grand final
        -- Losers bracket uses separate group numbers to make it easier to reason about:
        -- For N winner groups (1..N), we create N loser groups (N+1..2N) with path='LB'.
        IF stage_type = 'DoubleElimination' THEN
            PERFORM generate_double_elimination_bracket(stage.id, teams_per_group, stage.groups, next_stage_max_teams);
        ELSE
            RAISE NOTICE '  => Linking matches within stage %', stage."order";
            PERFORM link_tournament_stage_matches(stage.id);

            -- SE decider: apply decider best_of to final and optionally create 3rd place match
            IF stage.decider_best_of IS NOT NULL THEN
                DECLARE
                    _decider_match_options_id uuid;
                    _final_bracket_id uuid;
                    _third_place_id uuid;
                    _semi_record RECORD;
                BEGIN
                    _decider_match_options_id := update_match_options_best_of(stage.id);

                    -- Apply decider match_options to the final (last round, match 1)
                    SELECT id INTO _final_bracket_id
                    FROM tournament_brackets
                    WHERE tournament_stage_id = stage.id
                      AND path = 'WB'
                      AND round = total_rounds
                      AND match_number = 1
                    LIMIT 1;

                    IF _final_bracket_id IS NOT NULL AND _decider_match_options_id IS NOT NULL THEN
                        UPDATE tournament_brackets
                        SET match_options_id = _decider_match_options_id
                        WHERE id = _final_bracket_id;

                        RAISE NOTICE '  => SE decider: applied decider match_options to final bracket %', _final_bracket_id;
                    END IF;

                    -- Create 3rd place match if there are at least 2 rounds (semifinals exist)
                    IF total_rounds >= 2 THEN
                        INSERT INTO tournament_brackets (
                            round, tournament_stage_id, match_number, "group", path, match_options_id
                        ) VALUES (
                            total_rounds, stage.id, 2, 1, 'WB', _decider_match_options_id
                        )
                        RETURNING id INTO _third_place_id;

                        RAISE NOTICE '  => SE decider: created 3rd place bracket % in round %', _third_place_id, total_rounds;

                        -- Set loser_parent_bracket_id on semifinal brackets to route losers to 3rd place match
                        FOR _semi_record IN
                            SELECT id FROM tournament_brackets
                            WHERE tournament_stage_id = stage.id
                              AND path = 'WB'
                              AND round = total_rounds - 1
                            ORDER BY match_number ASC
                        LOOP
                            UPDATE tournament_brackets
                            SET loser_parent_bracket_id = _third_place_id
                            WHERE id = _semi_record.id;

                            RAISE NOTICE '  => SE decider: set semifinal % loser -> 3rd place %', _semi_record.id, _third_place_id;
                        END LOOP;
                    END IF;
                END;
            END IF;
        END IF;
    END LOOP;

    RAISE NOTICE '--- LINKING TOURNAMENT STAGES ---';
    PERFORM link_tournament_stages(_tournament_id);

    RAISE NOTICE '=== TOURNAMENT STAGE UPDATE COMPLETE ===';
    
    PERFORM calculate_tournament_bracket_start_times(_tournament_id);
END;
$$ LANGUAGE plpgsql;
