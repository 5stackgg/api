CREATE OR REPLACE FUNCTION public.check_swiss_round_complete(_stage_id uuid, _round int)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    unfinished_count int;
    total_matches int;
BEGIN
    SELECT COUNT(*) INTO unfinished_count
    FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = _stage_id
      AND tb.round = _round
      AND tb.finished = false;
    
    SELECT COUNT(*) INTO total_matches
    FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = _stage_id
      AND tb.round = _round;
    
    RETURN unfinished_count = 0 AND total_matches > 0;
END;
$$;

