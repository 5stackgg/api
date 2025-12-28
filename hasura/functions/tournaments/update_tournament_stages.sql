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
        teams_per_group := CEIL(effective_teams::float / stage.groups);
        
        IF stage_type = 'RoundRobin' THEN
            RAISE NOTICE 'Stage % : RoundRobin detected, teams_per_group=%, groups=%', 
                stage."order", teams_per_group, stage.groups;
            
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
                FOR g IN 1..stage.groups LOOP
                    RAISE NOTICE '  => Generating RoundRobin matches for group %', g;
                    
                    -- Calculate which seeds belong to this group
                    DECLARE
                        group_start_seed int;
                        group_end_seed int;
                        team_seeds int[];
                    BEGIN
                        group_start_seed := (g - 1) * teams_per_group + 1;
                        group_end_seed := g * teams_per_group;
                        
                        -- Build array of seeds for this group
                        -- Teams are distributed: group 1 gets seeds 1-N, group 2 gets seeds N+1-2N, etc.
                        team_seeds := ARRAY[]::int[];
                        FOR i IN group_start_seed..LEAST(group_end_seed, effective_teams) LOOP
                            team_seeds := team_seeds || i;
                        END LOOP;
                        
                        IF array_length(team_seeds, 1) < 2 THEN
                            RAISE NOTICE '  => Skipping group %: only % teams (need at least 2)', 
                                g, COALESCE(array_length(team_seeds, 1), 0);
                            CONTINUE;
                        END IF;
                        
                        RAISE NOTICE '  => Group %: % teams (seeds % to %)', 
                            g, array_length(team_seeds, 1), group_start_seed, LEAST(group_end_seed, effective_teams);
                        
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
                RAISE EXCEPTION 'Swiss tournament first round must have an even number of teams. Current: %', effective_teams;
            END IF;
            
            -- Generate entire Swiss bracket with all rounds and pools
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
            RAISE NOTICE '  => Generating double elimination structure for stage %', stage."order";
            DECLARE
                g int;
                loser_group_num int;
                wb_round_count int;
                r int;
                wb_round_matches int;
                lb_round_matches int;
                wb_match_ids uuid[];
                lb_match_ids uuid[];
                lb_prev_match_ids uuid[];
                i int;
                j int;
                teams_advancing int;
                wb_final_id uuid;
                lb_final_id uuid;
                gf_id uuid;
            BEGIN
                -- Determine winners bracket round count
                SELECT MAX(round) INTO wb_round_count
                FROM tournament_brackets
                WHERE tournament_stage_id = stage.id AND path = 'WB';
                
                RAISE NOTICE '  => Winners bracket has % rounds', wb_round_count;
                
                -- Calculate teams advancing from this stage (WB champion + LB champion per group)
                teams_advancing := 2 * stage.groups;

                -- Build losers bracket per group (separate loser group id with path='LB')
                FOR g IN 1..stage.groups LOOP
                    -- Loser group number: winners_group + stage.groups (e.g. WB group 1 -> LB group N+1)
                    loser_group_num := g + stage.groups;
                    RAISE NOTICE '  => Creating loser group % for winners group %', loser_group_num, g;
                    
                    lb_prev_match_ids := NULL;
                    
                    -- Generate LB rounds (same number as WB rounds)
                    FOR r IN 1..wb_round_count LOOP
                        -- Get WB matches for this round
                        SELECT array_agg(id ORDER BY match_number ASC) INTO wb_match_ids
                        FROM tournament_brackets
                        WHERE tournament_stage_id = stage.id AND path = 'WB' AND round = r AND "group" = g;
                        
                        wb_round_matches := COALESCE(array_length(wb_match_ids, 1), 0);
                        IF wb_round_matches = 0 THEN
                            CONTINUE;
                        END IF;
                        
                        -- Calculate LB matches for this round
                        IF r = 1 THEN
                            -- LB Round 1: receives losers from WB Round 1 (paired 2 at a time)
                            lb_round_matches := wb_round_matches / 2;
                        ELSE
                            -- LB Round r: receives losers from WB Round r (1-to-1) + winners from LB Round (r-1)
                            lb_round_matches := wb_round_matches;
                        END IF;
                        
                        -- Create LB matches for this round in the loser group
                        lb_match_ids := ARRAY[]::uuid[];
                        FOR i IN 1..lb_round_matches LOOP
                            INSERT INTO tournament_brackets (round, tournament_stage_id, match_number, "group", path)
                            VALUES (r, stage.id, i, loser_group_num, 'LB')
                            RETURNING id INTO new_id;
                            lb_match_ids := lb_match_ids || new_id;
                        END LOOP;
                        
                        -- Link WB losers to LB matches in the loser group
                        IF r = 1 THEN
                            -- Pair WB Round 1 losers two-at-a-time into LB Round 1
                            FOR i IN 1..wb_round_matches LOOP
                                j := ((i - 1) / 2) + 1;
                                IF j <= lb_round_matches THEN
                                    UPDATE tournament_brackets
                                    SET loser_parent_bracket_id = lb_match_ids[j]
                                    WHERE id = wb_match_ids[i];
                                END IF;
                            END LOOP;
                        ELSE
                            -- Map WB Round r losers one-to-one into LB Round r
                            FOR i IN 1..LEAST(wb_round_matches, lb_round_matches) LOOP
                                UPDATE tournament_brackets
                                SET loser_parent_bracket_id = lb_match_ids[i]
                                WHERE id = wb_match_ids[i];
                            END LOOP;
                            -- Note: LB round winners linking is handled by link_tournament_stage_matches
                            -- which uses 1-to-1 mapping by match number for LB paths
                        END IF;
                        
                        lb_prev_match_ids := lb_match_ids;
                    END LOOP;

                    -- For stages that produce a single champion, create a consolidation final in LB
                    -- and a Grand Final in WB:
                    --  - LB extra round (round = wb_round_count + 1, path='LB'):
                    --      participants = loser of WB final + winner of LB final
                    --  - WB extra round (round = wb_round_count + 1, path='WB'):
                    --      participants = winner of WB final + winner of LB extra round
                    IF wb_round_count > 0 AND next_stage_max_teams = 1 THEN
                        -- Identify WB and LB finals (last round in each path for this group)
                        SELECT id INTO wb_final_id
                        FROM tournament_brackets
                        WHERE tournament_stage_id = stage.id AND path = 'WB' AND round = wb_round_count AND "group" = g
                        ORDER BY match_number ASC LIMIT 1;

                        SELECT id INTO lb_final_id
                        FROM tournament_brackets
                        WHERE tournament_stage_id = stage.id AND path = 'LB' AND round = wb_round_count AND "group" = loser_group_num
                        ORDER BY match_number ASC LIMIT 1;

                        IF wb_final_id IS NOT NULL AND lb_final_id IS NOT NULL THEN
                            -- Create LB consolidation final (extra LB round)
                            INSERT INTO tournament_brackets (round, tournament_stage_id, match_number, "group", path)
                            VALUES (wb_round_count + 1, stage.id, 1, loser_group_num, 'LB')
                            RETURNING id INTO gf_id;

                            -- Winner of LB final advances to LB consolidation via parent_bracket_id
                            UPDATE tournament_brackets
                            SET parent_bracket_id = gf_id
                            WHERE id = lb_final_id;

                            -- Loser of WB final drops into LB consolidation via loser_parent_bracket_id
                            UPDATE tournament_brackets
                            SET loser_parent_bracket_id = gf_id
                            WHERE id = wb_final_id;

                            RAISE NOTICE '  => Created LB consolidation final for group % (round %, path LB)', g, wb_round_count + 1;

                            -- Create WB Grand Final as an extra WB round
                            INSERT INTO tournament_brackets (round, tournament_stage_id, match_number, "group", path)
                            VALUES (wb_round_count + 1, stage.id, 1, g, 'WB')
                            RETURNING id INTO gf_id;

                            -- Winner of WB final advances to Grand Final
                            UPDATE tournament_brackets
                            SET parent_bracket_id = gf_id
                            WHERE id = wb_final_id;

                            -- Winner of LB consolidation final advances to Grand Final
                            UPDATE tournament_brackets
                            SET parent_bracket_id = gf_id
                            WHERE id = (
                                SELECT id
                                FROM tournament_brackets
                                WHERE tournament_stage_id = stage.id
                                  AND path = 'LB'
                                  AND round = wb_round_count + 1
                                  AND "group" = loser_group_num
                                ORDER BY match_number ASC LIMIT 1
                            );

                            RAISE NOTICE '  => Created WB Grand Final for group % (round %, path WB)', g, wb_round_count + 1;
                        END IF;
                    ELSE
                        RAISE NOTICE '  => Skipping Grand Final for group % (next_stage_max_teams=%, both WB and LB champions advance directly)', g, next_stage_max_teams;
                    END IF;
                END LOOP;
            END;
        END IF;

        RAISE NOTICE '  => Linking matches within stage %', stage."order";
        PERFORM link_tournament_stage_matches(stage.id);
    END LOOP;

    RAISE NOTICE '--- LINKING TOURNAMENT STAGES ---';
    PERFORM link_tournament_stages(_tournament_id);

    RAISE NOTICE '=== TOURNAMENT STAGE UPDATE COMPLETE ===';
    
    PERFORM calculate_tournament_bracket_start_times(_tournament_id);
END;
$$ LANGUAGE plpgsql;