-- Reusable function to create round robin matches
-- Can work with either team IDs (for decider matches) or seeds (for initial tournament setup)
CREATE OR REPLACE FUNCTION public.create_round_robin_matches(
    _stage_id uuid,
    _group int,
    _start_round int,
    _team_ids uuid[] DEFAULT NULL,
    _team_seeds int[] DEFAULT NULL,
    _schedule_round_1 boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    team_count int;
    round_count int;
    matches_per_round int;
    match_counter int;
    round_num int;
    i int;
    k int;
    rotated_idx int;
    rotation_offset int;
    team_1_id uuid;
    team_2_id uuid;
    team_1_seed int;
    team_2_seed int;
    rotated_teams uuid[];
    rotated_seeds int[];
    idx1 int;
    idx2 int;
    bracket_record tournament_brackets%ROWTYPE;
    use_team_ids boolean;
BEGIN
    -- Determine if we're using team IDs or seeds
    IF _team_ids IS NOT NULL AND array_length(_team_ids, 1) > 0 THEN
        use_team_ids := true;
        team_count := array_length(_team_ids, 1);
    ELSIF _team_seeds IS NOT NULL AND array_length(_team_seeds, 1) > 0 THEN
        use_team_ids := false;
        team_count := array_length(_team_seeds, 1);
    ELSE
        RAISE EXCEPTION 'Need either team_ids or team_seeds array';
    END IF;
    
    IF team_count < 2 THEN
        RAISE EXCEPTION 'Need at least 2 teams for round robin, got %', team_count;
    END IF;
    
    -- Calculate rounds needed for round robin
    IF team_count % 2 = 0 THEN
        round_count := team_count - 1;
        matches_per_round := team_count / 2;
    ELSE
        round_count := team_count;
        matches_per_round := (team_count - 1) / 2;
    END IF;
    
    RAISE NOTICE 'Creating round robin matches for % teams: % rounds, % matches per round, starting at round %', 
        team_count, round_count, matches_per_round, _start_round;
    
    match_counter := 0;
    
    -- Generate round robin matches using rotating algorithm
    FOR round_num IN 1..round_count LOOP
        IF use_team_ids THEN
            -- Create rotated array for this round (using team IDs)
            rotated_teams := ARRAY[]::uuid[];
            rotated_teams := rotated_teams || _team_ids[1];
            
            rotation_offset := (round_num - 1) % (team_count - 1);
            
            FOR k IN 1..(team_count - 1) LOOP
                rotated_idx := 1 + ((k - 1 + rotation_offset) % (team_count - 1)) + 1;
                rotated_teams := rotated_teams || _team_ids[rotated_idx];
            END LOOP;
        ELSE
            -- Create rotated array for this round (using seeds)
            rotated_seeds := ARRAY[]::int[];
            rotated_seeds := rotated_seeds || _team_seeds[1];
            
            rotation_offset := (round_num - 1) % (team_count - 1);
            
            FOR k IN 1..(team_count - 1) LOOP
                rotated_idx := 1 + ((k - 1 + rotation_offset) % (team_count - 1)) + 1;
                rotated_seeds := rotated_seeds || _team_seeds[rotated_idx];
            END LOOP;
        END IF;
        
        -- Pair teams: first with last, second with second-to-last, etc.
        FOR i IN 1..matches_per_round LOOP
            idx1 := i;
            idx2 := team_count + 1 - i;
            
            IF use_team_ids THEN
                team_1_id := rotated_teams[idx1];
                team_2_id := rotated_teams[idx2];
                
                -- Get seeds for these teams
                SELECT COALESCE(seed, 999999) INTO team_1_seed
                FROM tournament_teams
                WHERE id = team_1_id;
                
                SELECT COALESCE(seed, 999999) INTO team_2_seed
                FROM tournament_teams
                WHERE id = team_2_id;
            ELSE
                team_1_seed := rotated_seeds[idx1];
                team_2_seed := rotated_seeds[idx2];
                team_1_id := NULL;
                team_2_id := NULL;
            END IF;
            
            match_counter := match_counter + 1;
            
            INSERT INTO tournament_brackets (
                round, 
                tournament_stage_id, 
                match_number, 
                "group", 
                team_1_seed, 
                team_2_seed, 
                path,
                tournament_team_id_1,
                tournament_team_id_2
            )
            VALUES (
                _start_round + round_num - 1, 
                _stage_id, 
                match_counter, 
                _group, 
                team_1_seed, 
                team_2_seed, 
                'WB',
                team_1_id,
                team_2_id
            );
            
            IF use_team_ids THEN
                RAISE NOTICE 'Created match %: round %, team % vs team %', 
                    match_counter, _start_round + round_num - 1, team_1_id, team_2_id;
            ELSE
                RAISE NOTICE 'Created match %: round %, seed % vs seed %', 
                    match_counter, _start_round + round_num - 1, team_1_seed, team_2_seed;
            END IF;
        END LOOP;
    END LOOP;
    
    -- Schedule round 1 matches immediately if requested (only for decider matches with team IDs)
    IF _schedule_round_1 AND use_team_ids THEN
        FOR bracket_record IN 
            SELECT * FROM tournament_brackets 
            WHERE tournament_stage_id = _stage_id 
              AND round = _start_round
              AND "group" = _group
              AND match_id IS NULL
              AND tournament_team_id_1 IS NOT NULL 
              AND tournament_team_id_2 IS NOT NULL
        LOOP
            PERFORM schedule_tournament_match(bracket_record);
            RAISE NOTICE 'Scheduled round % match: bracket %', _start_round, bracket_record.id;
        END LOOP;
    END IF;
    
    RAISE NOTICE 'Created % round robin matches starting at round %', match_counter, _start_round;
END;
$$;

