CREATE OR REPLACE FUNCTION public.find_adjacent_swiss_team(
    _stage_id uuid,
    _wins int,
    _losses int,
    _exclude_team_ids uuid[] DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
    adjacent_team_id uuid;
    pool_record RECORD;
    preferred_pool RECORD;
    fallback_pool RECORD;
BEGIN
    -- Strategy: When pairing with adjacent pool, prefer:
    -- 1. Worst result with same wins (more losses) - e.g., if we have (1W, 1L), prefer (1W, 2L)
    -- 2. Best result with same losses (more wins) - e.g., if we have (1W, 1L), prefer (2W, 1L)
    -- This pairs worst 1-win teams with best 1-loss teams
    
    preferred_pool := NULL;
    fallback_pool := NULL;
    
    -- Check all pools for adjacent ones
    FOR pool_record IN 
        SELECT * FROM get_swiss_team_pools(_stage_id, _exclude_team_ids)
        WHERE (wins, losses) != (_wins, _losses)  -- Different pool
          AND team_count > 0  -- Has teams
    LOOP
        -- We want pools with exactly one win/loss difference
        -- This means: (wins_diff = 1 AND losses_diff = 0) OR (wins_diff = 0 AND losses_diff = 1)
        IF (ABS(pool_record.wins - _wins) = 1 AND pool_record.losses = _losses) OR
           (pool_record.wins = _wins AND ABS(pool_record.losses - _losses) = 1) THEN
            
            -- Priority 1: Same wins, more losses (worst result with same wins)
            -- e.g., if we have (1W, 1L), prefer (1W, 2L)
            IF pool_record.wins = _wins AND pool_record.losses > _losses THEN
                IF preferred_pool IS NULL OR pool_record.losses > preferred_pool.losses THEN
                    preferred_pool := pool_record;
                END IF;
            -- Priority 2: Same losses, more wins (best result with same losses)
            -- e.g., if we have (1W, 1L), prefer (2W, 1L)
            ELSIF pool_record.losses = _losses AND pool_record.wins > _wins THEN
                IF preferred_pool IS NULL OR pool_record.wins > preferred_pool.wins THEN
                    preferred_pool := pool_record;
                END IF;
            -- Fallback: Other adjacent pools (same wins fewer losses, or same losses fewer wins)
            ELSE
                IF fallback_pool IS NULL THEN
                    fallback_pool := pool_record;
                END IF;
            END IF;
        END IF;
    END LOOP;
    
    -- Use preferred pool if available, otherwise fallback
    IF preferred_pool IS NOT NULL AND array_length(preferred_pool.team_ids, 1) > 0 THEN
        adjacent_team_id := preferred_pool.team_ids[1];
        RAISE NOTICE '  Found preferred adjacent team % from pool (W:% L:%) for pool (W:% L:%)', 
            adjacent_team_id, preferred_pool.wins, preferred_pool.losses, _wins, _losses;
        RETURN adjacent_team_id;
    ELSIF fallback_pool IS NOT NULL AND array_length(fallback_pool.team_ids, 1) > 0 THEN
        adjacent_team_id := fallback_pool.team_ids[1];
        RAISE NOTICE '  Found fallback adjacent team % from pool (W:% L:%) for pool (W:% L:%)', 
            adjacent_team_id, fallback_pool.wins, fallback_pool.losses, _wins, _losses;
        RETURN adjacent_team_id;
    END IF;
    
    -- If no adjacent pool found, return NULL (shouldn't happen in practice)
    RAISE WARNING 'No adjacent pool found for (W:% L:%)', _wins, _losses;
    RETURN NULL;
END;
$$;

