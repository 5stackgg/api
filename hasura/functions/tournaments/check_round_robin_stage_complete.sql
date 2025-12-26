-- Function to check if all matches in a RoundRobin stage are finished
CREATE OR REPLACE FUNCTION public.check_round_robin_stage_complete(_stage_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    unfinished_count int;
BEGIN
    -- Count unfinished matches in this stage
    SELECT COUNT(*) INTO unfinished_count
    FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = _stage_id
      AND tb.finished = false;
    
    -- Return true if all matches are finished (unfinished_count = 0)
    RETURN unfinished_count = 0;
END;
$$;

