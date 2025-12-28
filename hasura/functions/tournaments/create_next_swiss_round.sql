CREATE OR REPLACE FUNCTION public.create_next_swiss_round(_stage_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    current_round int;
    next_round int;
    pool_record RECORD;
    total_teams int;
BEGIN
    -- Get current maximum round
    SELECT COALESCE(MAX(tb.round), 0) INTO current_round
    FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = _stage_id;
    
    next_round := current_round + 1;
    
    RAISE NOTICE '=== Creating Swiss Round % ===', next_round;
    
    -- Get teams grouped by W/L record
    -- Process pools in order, handling odd numbers by pairing with adjacent pools
    DECLARE
        adjacent_team_id uuid;
        used_teams uuid[];
    BEGIN
        used_teams := ARRAY[]::uuid[];
        
        FOR pool_record IN 
            SELECT * FROM get_swiss_team_pools(_stage_id, used_teams)
            ORDER BY wins DESC, losses ASC
        LOOP
            total_teams := pool_record.team_count;
            
            -- Skip pools with 0 teams
            IF total_teams = 0 THEN
                CONTINUE;
            END IF;
            
            RAISE NOTICE '  Pool: W:% L:% Teams:%', 
                pool_record.wins, pool_record.losses, total_teams;
            
            -- Handle odd number of teams by finding adjacent team
            adjacent_team_id := NULL;
            IF total_teams % 2 != 0 THEN
                -- Find a team from an adjacent pool (excluding already used teams)
                adjacent_team_id := find_adjacent_swiss_team(_stage_id, pool_record.wins, pool_record.losses, used_teams);
                
                IF adjacent_team_id IS NULL THEN
                    RAISE EXCEPTION 'Odd number of teams in pool (wins: %, losses: %, count: %) and no available adjacent team found', 
                        pool_record.wins, pool_record.losses, total_teams;
                END IF;
                
                -- Mark adjacent team as used
                used_teams := used_teams || adjacent_team_id;
            END IF;
            
            -- Pair teams within this pool (with adjacent team if needed)
            PERFORM pair_swiss_teams(
                _stage_id,
                next_round,
                pool_record.wins,
                pool_record.losses,
                pool_record.team_ids,
                adjacent_team_id
            );
        END LOOP;
    END;
    
    RAISE NOTICE '=== Swiss Round % Created ===', next_round;
END;
$$;

