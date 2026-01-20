CREATE OR REPLACE FUNCTION public.assign_teams_to_swiss_pools(_stage_id uuid, _round int)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    pool_record RECORD;
    bracket_record RECORD;
    team_count int;
    matches_needed int;
    match_counter int;
    bracket_order int[];
    i int;
    seed_1_idx int;
    seed_2_idx int;
    team_1_id uuid;
    team_2_id uuid;
    adjacent_team_id uuid;
    used_teams uuid[];
    teams_to_pair uuid[];
BEGIN
    RAISE NOTICE '=== Assigning Teams to Swiss Pools for Round % ===', _round;
    
    used_teams := ARRAY[]::uuid[];
    
    FOR pool_record IN 
        SELECT * FROM get_swiss_team_pools(_stage_id, used_teams)
        ORDER BY wins DESC, losses ASC
    LOOP
        team_count := pool_record.team_count;
        
        IF team_count = 0 THEN
            CONTINUE;
        END IF;
        
            -- Calculate pool group: wins * 100 + losses
            DECLARE
                pool_group numeric;
            BEGIN
                pool_group := pool_record.wins * 100 + pool_record.losses;
                
                RAISE NOTICE '  Pool %-% (group %): % teams', 
                    pool_record.wins, pool_record.losses, pool_group, team_count;
            
            -- Handle odd number of teams
            adjacent_team_id := NULL;
            teams_to_pair := pool_record.team_ids;
            
            IF team_count % 2 != 0 THEN
                -- Find a team from an adjacent pool
                adjacent_team_id := find_adjacent_swiss_team(_stage_id, pool_record.wins, pool_record.losses, used_teams);
                
                IF adjacent_team_id IS NOT NULL THEN
                    teams_to_pair := teams_to_pair || adjacent_team_id;
                    used_teams := used_teams || adjacent_team_id;
                    RAISE NOTICE '    Borrowed team % from adjacent pool', adjacent_team_id;
                ELSE
                    RAISE EXCEPTION 'Odd number of teams in pool %-% and no adjacent team found', 
                        pool_record.wins, pool_record.losses USING ERRCODE = '22000';
                END IF;
            END IF;
            
            matches_needed := array_length(teams_to_pair, 1) / 2;
            
            -- For Swiss tournaments, use bracket order for pairing
            -- Filter bracket_order to only include valid seed positions (1 to teams_to_pair.length)
            bracket_order := generate_bracket_order(array_length(teams_to_pair, 1));
            DECLARE
                filtered_order int[];
                valid_seed int;
            BEGIN
                filtered_order := ARRAY[]::int[];
                FOREACH valid_seed IN ARRAY bracket_order LOOP
                    IF valid_seed >= 1 AND valid_seed <= array_length(teams_to_pair, 1) THEN
                        filtered_order := filtered_order || valid_seed;
                    END IF;
                END LOOP;
                bracket_order := filtered_order;
            END;
            
            -- Validate we have enough valid seed positions
            IF array_length(bracket_order, 1) < matches_needed * 2 THEN
                RAISE EXCEPTION 'Not enough valid seed positions in bracket order for pool %-% (needed: %, got: %)', 
                    pool_record.wins, pool_record.losses, matches_needed * 2, array_length(bracket_order, 1) USING ERRCODE = '22000';
            END IF;
            
            match_counter := 1;
            FOR i IN 1..matches_needed LOOP
                -- Get seed positions from filtered bracket order
                seed_1_idx := bracket_order[(i - 1) * 2 + 1];
                seed_2_idx := bracket_order[(i - 1) * 2 + 2];
                
                team_1_id := teams_to_pair[seed_1_idx];
                team_2_id := teams_to_pair[seed_2_idx];
                
                -- Validate that teams are not NULL
                IF team_1_id IS NULL OR team_2_id IS NULL THEN
                    RAISE EXCEPTION 'NULL team found in pool %-% at match % (seed_1_idx: %, seed_2_idx: %, teams_to_pair length: %)', 
                        pool_record.wins, pool_record.losses, match_counter, seed_1_idx, seed_2_idx, array_length(teams_to_pair, 1) USING ERRCODE = '22000';
                END IF;
                
                SELECT id INTO bracket_record
                    FROM tournament_brackets
                    WHERE tournament_stage_id = _stage_id
                    AND round = _round
                    AND "group" = pool_group
                    AND match_number = match_counter
                    LIMIT 1;
                
                IF bracket_record IS NULL THEN
                    RAISE EXCEPTION 'Bracket record not found for match % in pool %-% (group %)', 
                        match_counter, pool_record.wins, pool_record.losses, pool_group USING ERRCODE = '22000';
                END IF;

                UPDATE tournament_brackets
                    SET tournament_team_id_1 = team_1_id,
                        tournament_team_id_2 = team_2_id,
                        bye = false
                    WHERE id = bracket_record.id;
                
                -- Mark both teams as used to prevent double-assignment
                used_teams := used_teams || team_1_id || team_2_id;
            
                RAISE NOTICE '    Match %: Team % vs Team %', match_counter, team_1_id, team_2_id;
                match_counter := match_counter + 1;
            END LOOP;
        END;
    END LOOP;
    
    RAISE NOTICE '=== Team Assignment Complete ===';
END;
$$;

