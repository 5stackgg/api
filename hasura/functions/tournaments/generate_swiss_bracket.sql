CREATE OR REPLACE FUNCTION public.generate_swiss_bracket(_stage_id uuid, _team_count int)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    max_rounds int;
    wins_needed int;  -- Number of wins needed to advance (Valve-style: 3)
    round_num int;
    wins int;
    losses int;
    pool_group numeric;
    matches_needed int;
    match_num int;
    bracket_order int[];
    seed_1 int;
    seed_2 int;
    bracket_idx int;
    match_options_id uuid;
    is_elimination_match boolean;
    is_advancement_match boolean;
BEGIN
    -- Valve-style Swiss system: teams need 3 wins to advance or 3 losses to be eliminated
    -- Max rounds formula: 2 × wins_needed - 1
    -- This ensures all teams will either advance or be eliminated
    wins_needed := 3;
    max_rounds := 2 * wins_needed - 1;  -- For 3 wins: 2 × 3 - 1 = 5 rounds
    
    RAISE NOTICE '=== Generating Swiss Bracket for % teams ===', _team_count;
    RAISE NOTICE 'Will generate rounds 1 through %', max_rounds;
    
    -- Round 1: All teams start at 0-0
    round_num := 1;
    pool_group := 0;  -- 0 wins, 0 losses = group 0 (encoded as wins*100 + losses)
    matches_needed := _team_count / 2;
    
    -- Generate bracket order for first round
    bracket_order := generate_bracket_order(_team_count);
    -- generate_bracket_order() returns the next power-of-2 ordering (to support byes).
    -- For Swiss round 1 we want to display seeds for *all* teams (no implicit byes when _team_count is even),
    -- so we filter the order down to valid seed positions 1.._team_count (same approach as assign_teams_to_swiss_pools()).
    DECLARE
        filtered_order int[];
        valid_seed int;
    BEGIN
        filtered_order := ARRAY[]::int[];
        FOREACH valid_seed IN ARRAY bracket_order LOOP
            IF valid_seed >= 1 AND valid_seed <= _team_count THEN
                filtered_order := filtered_order || valid_seed;
            END IF;
        END LOOP;
        bracket_order := filtered_order;
    END;
    bracket_idx := 0;
    
    RAISE NOTICE 'Round %: Pool 0-0 (group %), % matches', round_num, pool_group, matches_needed;
    
    FOR match_num IN 1..matches_needed LOOP
        -- Get seed positions from bracket order
        IF bracket_idx * 2 + 1 <= array_length(bracket_order, 1) THEN
            seed_1 := bracket_order[bracket_idx * 2 + 1];
        ELSE
            seed_1 := NULL;
        END IF;
        
        IF bracket_idx * 2 + 2 <= array_length(bracket_order, 1) THEN
            seed_2 := bracket_order[bracket_idx * 2 + 2];
        ELSE
            seed_2 := NULL;
        END IF;
        
        -- Set to NULL if seed position is beyond team_count
        IF seed_1 IS NOT NULL AND seed_1 > _team_count THEN
            seed_1 := NULL;
        END IF;
        IF seed_2 IS NOT NULL AND seed_2 > _team_count THEN
            seed_2 := NULL;
        END IF;
        
        INSERT INTO tournament_brackets (
            round,
            tournament_stage_id,
            match_number,
            "group",
            team_1_seed,
            team_2_seed,
            path
        )
        VALUES (
            round_num,
            _stage_id,
            match_num,
            pool_group,
            seed_1,
            seed_2,
            'WB'
        );
        
        bracket_idx := bracket_idx + 1;
    END LOOP;
    
    -- Generate subsequent rounds
    -- For each round, create pools for all possible W/L combinations
    RAISE NOTICE 'Starting generation of rounds 2 through %', max_rounds;
    RAISE NOTICE 'About to enter loop for rounds 2 to %', max_rounds;
    
    -- Explicitly ensure the loop runs
    round_num := 2;
    WHILE round_num <= max_rounds LOOP
        RAISE NOTICE '=== Round %: Generating pools ===', round_num;
        
        -- Generate all possible W/L combinations for this round
        -- Teams can have 0 to wins_needed wins and 0 to wins_needed losses, but total wins+losses = round_num - 1
        DECLARE
            pools_created int := 0;
            matches_created int := 0;
        BEGIN
            FOR wins IN 0..LEAST(wins_needed, round_num - 1) LOOP
                losses := (round_num - 1) - wins;
                
                -- Skip if losses > wins_needed (team would be eliminated)
                IF losses > wins_needed THEN
                    RAISE NOTICE '  Skipping pool %-% (losses > %)', wins, losses, wins_needed;
                    CONTINUE;
                END IF;
                
                -- Skip pools where teams would have advanced (wins_needed wins, < wins_needed losses)
                -- These teams won't play more matches
                IF wins = wins_needed AND losses < wins_needed THEN
                    RAISE NOTICE '  Skipping pool %-% (advanced)', wins, losses;
                    CONTINUE;
                END IF;
                
                -- Skip pools where teams would be eliminated (wins_needed losses)
                -- These teams won't play more matches
                IF losses = wins_needed THEN
                    RAISE NOTICE '  Skipping pool %-% (eliminated)', wins, losses;
                    CONTINUE;
                END IF;
                
                -- Calculate pool group: wins * 100 + losses
                pool_group := wins * 100 + losses;
                
                -- Use the unified formula for matches: matches(N, r, w, l)
                -- If r <= 3: matches = (1/2) * C(r-1, w) * (N / 2^(r-1))
                -- If r = 4 AND (w,l) ∈ {(2,1), (1,2)}: matches = 3N / 16
                -- If r = 5 AND (w,l) = (2,2): matches = 3N / 16
                -- Otherwise: 0 (advanced/eliminated pools)
                DECLARE
                    matches_calc numeric;
                BEGIN
                    IF round_num <= 3 THEN
                        -- Use binomial distribution for early rounds
                        DECLARE
                            n int;
                            k int;
                            binomial_coefficient numeric;
                        BEGIN
                            n := round_num - 1;
                            k := wins;
                            binomial_coefficient := public.binomial_coefficient(n, k);
                            -- Formula: (1/2) * C(r-1, w) * (N / 2^(r-1))
                            matches_calc := (1.0 / 2.0) * binomial_coefficient * (_team_count::numeric / POWER(2, n));
                        END;
                    ELSIF round_num = 4 AND ((wins = 2 AND losses = 1) OR (wins = 1 AND losses = 2)) THEN
                        -- Round 4: pools (2,1) and (1,2) get 3N/16 matches
                        matches_calc := 3.0 * _team_count::numeric / 16.0;
                    ELSIF round_num = 5 AND wins = 2 AND losses = 2 THEN
                        -- Round 5: pool (2,2) gets 3N/16 matches
                        matches_calc := 3.0 * _team_count::numeric / 16.0;
                    ELSE
                        -- All other pools in rounds 4+ are advanced/eliminated
                        matches_calc := 0;
                    END IF;
                    
                    -- Round up to get integer matches
                    matches_needed := CEIL(matches_calc)::int;
                    
                    -- Ensure we don't exceed reasonable bounds
                    IF matches_needed > _team_count / 2 THEN
                        matches_needed := _team_count / 2;
                    END IF;
                    
                    RAISE NOTICE '  Creating pool %-% (group %): % matches (calculated: ~%)', 
                        wins, losses, pool_group, matches_needed, ROUND(matches_calc, 2);
                END;
                
                -- Check if this is an elimination or advancement match
                -- Elimination: losses = wins_needed - 1 (next loss eliminates)
                -- Advancement: wins = wins_needed - 1 (next win advances)
                is_elimination_match := (losses = wins_needed - 1);
                is_advancement_match := (wins = wins_needed - 1);
                
                -- Get match_options_id, creating a new one with best_of=3 if it's elimination/advancement
                IF is_elimination_match OR is_advancement_match THEN
                    match_options_id := update_match_options_best_of(_stage_id);
                ELSE
                    match_options_id := NULL;
                END IF;
                
                -- Create placeholder matches for this pool
                -- Each pool gets its own match_number sequence starting from 1
                FOR match_num IN 1..matches_needed LOOP
                    INSERT INTO tournament_brackets (
                        round,
                        tournament_stage_id,
                        match_number,
                        "group",
                        path,
                        match_options_id
                    )
                    VALUES (
                        round_num,
                        _stage_id,
                        match_num,
                        pool_group,
                        'WB',
                        match_options_id
                    );
                    matches_created := matches_created + 1;
                END LOOP;
                
                pools_created := pools_created + 1;
            END LOOP;
            
            RAISE NOTICE 'Round % complete: % pools, % matches created', round_num, pools_created, matches_created;
        END;
        
        round_num := round_num + 1;
    END LOOP;
    
    RAISE NOTICE 'Finished generating all rounds 2 through %', max_rounds;
    
    -- Summary: Count total brackets created
    DECLARE
        total_brackets int;
        brackets_by_round RECORD;
    BEGIN
        SELECT COUNT(*) INTO total_brackets
        FROM tournament_brackets
        WHERE tournament_stage_id = _stage_id;
        
        RAISE NOTICE '=== Swiss Bracket Generation Complete ===';
        RAISE NOTICE 'Total brackets created: %', total_brackets;
        
        -- Show breakdown by round
        FOR brackets_by_round IN
            SELECT round, COUNT(*) as bracket_count, COUNT(DISTINCT "group") as pool_count
            FROM tournament_brackets
            WHERE tournament_stage_id = _stage_id
            GROUP BY round
            ORDER BY round
        LOOP
            RAISE NOTICE 'Round %: % brackets across % pools', 
                brackets_by_round.round, 
                brackets_by_round.bracket_count,
                brackets_by_round.pool_count;
        END LOOP;
    END;
END;
$$;

