CREATE OR REPLACE FUNCTION public.pair_swiss_teams(
    _stage_id uuid,
    _round int,
    _wins int,
    _losses int,
    _team_ids uuid[],
    _adjacent_team_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    team_count int;
    bracket_order int[];
    match_number int;
    i int;
    seed_1_idx int;
    seed_2_idx int;
    team_1_id uuid;
    team_2_id uuid;
    group_num int;
    teams_to_pair uuid[];
    pairing_count int;
BEGIN
    team_count := array_length(_team_ids, 1);
    
    -- Get group number from stage (Swiss uses single group, so should be 1)
    SELECT COALESCE(ts.groups, 1) INTO group_num
    FROM tournament_stages ts
    WHERE ts.id = _stage_id;
    
    -- Ensure group_num is 1 for Swiss
    IF group_num IS NULL OR group_num != 1 THEN
        group_num := 1;
    END IF;
    
    -- Handle odd number of teams by pairing with adjacent pool team
    IF team_count % 2 != 0 THEN
        IF _adjacent_team_id IS NULL THEN
            -- Try to find an adjacent team
            _adjacent_team_id := find_adjacent_swiss_team(_stage_id, _wins, _losses);
        END IF;
        
        IF _adjacent_team_id IS NOT NULL THEN
            -- Add adjacent team to the pool for pairing
            teams_to_pair := _team_ids || _adjacent_team_id;
            RAISE NOTICE '  Pool (W:% L:%) has odd number of teams (%), pairing with adjacent team %', 
                _wins, _losses, team_count, _adjacent_team_id;
        ELSE
            RAISE EXCEPTION 'Odd number of teams in pool (wins: %, losses: %, count: %) and no adjacent team found', 
                _wins, _losses, team_count;
        END IF;
    ELSE
        teams_to_pair := _team_ids;
    END IF;
    
    pairing_count := array_length(teams_to_pair, 1);
    
    -- Generate bracket order for pairing teams
    bracket_order := generate_bracket_order(pairing_count);
    
    -- Pair teams using bracket order
    match_number := 1;
    FOR i IN 1..(pairing_count / 2) LOOP
        -- Get indices from bracket order (1-based)
        seed_1_idx := bracket_order[(i - 1) * 2 + 1];
        seed_2_idx := bracket_order[(i - 1) * 2 + 2];
        
        -- Get team IDs (bracket_order uses 1-based indexing, array uses 1-based)
        team_1_id := teams_to_pair[seed_1_idx];
        team_2_id := teams_to_pair[seed_2_idx];
        
        -- Create match bracket
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
            match_number,
            group_num,
            team_1_id,
            team_2_id,
            'WB'
        );
        
        RAISE NOTICE '  Created match %: Team % vs Team % (W:% L:%)', 
            match_number, team_1_id, team_2_id, _wins, _losses;
        
        match_number := match_number + 1;
    END LOOP;
END;
$$;


