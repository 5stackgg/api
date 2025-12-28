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
    
    -- Get all pools for this round, ordered by wins DESC, losses ASC
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
                        pool_record.wins, pool_record.losses;
                END IF;
            END IF;
            
            -- Calculate matches needed
            matches_needed := array_length(teams_to_pair, 1) / 2;
            
            -- Generate bracket order for pairing
            bracket_order := generate_bracket_order(array_length(teams_to_pair, 1));
            
            -- Assign teams to brackets
            match_counter := 1;
            FOR i IN 1..matches_needed LOOP
                -- Get indices from bracket order
                seed_1_idx := bracket_order[(i - 1) * 2 + 1];
                seed_2_idx := bracket_order[(i - 1) * 2 + 2];
                
                -- Get team IDs
                team_1_id := teams_to_pair[seed_1_idx];
                team_2_id := teams_to_pair[seed_2_idx];
                
                -- Find or create bracket for this match
                SELECT id INTO bracket_record
                FROM tournament_brackets
                WHERE tournament_stage_id = _stage_id
                  AND round = _round
                  AND "group" = pool_group
                  AND match_number = match_counter
                LIMIT 1;
                
                IF bracket_record IS NOT NULL THEN
                    -- Update existing bracket
                    UPDATE tournament_brackets
                    SET tournament_team_id_1 = team_1_id,
                        tournament_team_id_2 = team_2_id,
                        bye = false
                    WHERE id = bracket_record.id;
                ELSE
                    -- Create new bracket if needed
                    INSERT INTO tournament_brackets (
                        round,
                        tournament_stage_id,
                        match_number,
                        "group",
                        tournament_team_id_1,
                        tournament_team_id_2,
                        path
                    )
                    VALUES (
                        _round,
                        _stage_id,
                        match_counter,
                        pool_group,
                        team_1_id,
                        team_2_id,
                        'WB'
                    );
                END IF;
                
                RAISE NOTICE '    Match %: Team % vs Team %', match_counter, team_1_id, team_2_id;
                match_counter := match_counter + 1;
            END LOOP;
            
            -- Remove unused brackets for this pool
            DELETE FROM tournament_brackets
            WHERE tournament_stage_id = _stage_id
              AND round = _round
              AND "group" = pool_group
              AND match_number >= match_counter;
        END;
    END LOOP;
    
    RAISE NOTICE '=== Team Assignment Complete ===';
END;
$$;

