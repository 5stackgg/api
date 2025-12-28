CREATE OR REPLACE FUNCTION public.check_round_robin_stage_complete(_stage_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    unfinished_count int;
BEGIN
    SELECT COUNT(*) INTO unfinished_count
    FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = _stage_id
      AND tb.finished = false;
    
    RETURN unfinished_count = 0;
END;
$$;

