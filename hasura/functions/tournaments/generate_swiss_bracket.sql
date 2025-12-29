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
                
                -- Calculate expected number of teams in this pool using binomial distribution
                -- For round N, with W wins and L losses (W+L = N-1):
                -- Expected teams = team_count * C(N-1, W) / 2^(N-1)
                DECLARE
                    n int;
                    k int;
                    expected_teams_in_pool numeric;
                    binomial_coefficient numeric;
                    reduction_factor numeric;
                    teams_advanced_eliminated numeric;
                    total_expected_remaining numeric;
                BEGIN
                    n := round_num - 1;
                    k := wins;
                    
                    -- Calculate binomial coefficient using helper function
                    binomial_coefficient := public.binomial_coefficient(n, k);
                    
                    -- Expected teams = team_count * C(n, k) / 2^n
                    -- This gives the theoretical expected number of teams in this W/L pool
                    expected_teams_in_pool := _team_count::numeric * binomial_coefficient / POWER(2, n);
                    
                    -- For later rounds, we need to account for teams that have already advanced or been eliminated
                    -- However, the binomial distribution already accounts for the natural distribution
                    -- We only apply a light adjustment for very late rounds to account for edge cases
                    -- Note: Round (wins_needed + 2) is the final round, so we don't apply reduction there
                    IF round_num > wins_needed + 2 THEN
                        -- For rounds beyond wins_needed + 2, apply a conservative reduction
                        -- This accounts for the fact that some teams have advanced/eliminated
                        -- But we use a much lighter touch to avoid over-reduction
                        DECLARE
                            rounds_past_threshold int;
                            light_reduction numeric;
                        BEGIN
                            rounds_past_threshold := round_num - (wins_needed + 2);
                            -- Apply a very light reduction: 5% per round past threshold, max 20%
                            light_reduction := GREATEST(0.8, 1.0 - (rounds_past_threshold * 0.05));
                            expected_teams_in_pool := expected_teams_in_pool * light_reduction;
                        END;
                    END IF;
                    
                    -- Round to nearest integer, but ensure at least 2 for a match
                    IF expected_teams_in_pool < 2 THEN
                        matches_needed := 0;
                    ELSE
                        matches_needed := CEIL(expected_teams_in_pool / 2.0)::int;
                    END IF;
                    
                    -- Cap at reasonable maximum (half of team count per pool)
                    IF matches_needed > _team_count / 2 THEN
                        matches_needed := _team_count / 2;
                    END IF;
                    
                    -- Ensure minimum of 1 match if we expect teams (for odd numbers handled later)
                    IF matches_needed = 0 AND expected_teams_in_pool >= 1.5 THEN
                        matches_needed := 1;
                    END IF;
                    
                    RAISE NOTICE '  Creating pool %-% (group %): % matches (expected ~% teams, binomial C(%,%)=%)', 
                        wins, losses, pool_group, matches_needed, 
                        ROUND(expected_teams_in_pool, 1), n, k, binomial_coefficient;
                END;
                
                -- Create placeholder matches for this pool
                -- Each pool gets its own match_number sequence starting from 1
                FOR match_num IN 1..matches_needed LOOP
                    INSERT INTO tournament_brackets (
                        round,
                        tournament_stage_id,
                        match_number,
                        "group",
                        path
                    )
                    VALUES (
                        round_num,
                        _stage_id,
                        match_num,
                        pool_group,
                        'WB'
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

