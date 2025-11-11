CREATE OR REPLACE FUNCTION generate_bracket_order(entrants int) RETURNS int[] AS $$
DECLARE
    bracket_order int[];
    target_size int;
    doubled_size int;
    doubled_order int[];
    seed_val int;
BEGIN
    -- Start with the base case: [1,2] for 2 teams (the final match)
    bracket_order := ARRAY[1, 2];
    
    -- Calculate target size (next power of 2 to handle byes correctly)
    target_size := POWER(2, CEIL(LOG(entrants::numeric) / LOG(2)))::int;
    
    -- Recursively double the bracket until we reach the target size
    WHILE array_length(bracket_order, 1) < target_size LOOP
        doubled_size := array_length(bracket_order, 1) * 2;
        doubled_order := ARRAY[]::int[];
        
        -- For each seed in current bracket, add it and its opponent
        -- The opponent is calculated as (doubled_size + 1 - seed)
        -- This ensures seeds always add up to (doubled_size + 1) in first round
        FOREACH seed_val IN ARRAY bracket_order LOOP
            doubled_order := doubled_order || seed_val;
            doubled_order := doubled_order || (doubled_size + 1 - seed_val);
        END LOOP;
        
        bracket_order := doubled_order;
    END LOOP;
    
    -- Note: We don't trim the bracket_order - positions beyond 'entrants' will result in byes
    
    RETURN bracket_order;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
