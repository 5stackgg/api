CREATE OR REPLACE FUNCTION public.get_team_next_round_bracket_id(
    _team_id uuid,
    _stage_id uuid,
    _current_round int,
    _group int
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
    next_round int;
    bracket_id uuid;
BEGIN
    next_round := _current_round + 1;
    
    SELECT tb.id INTO bracket_id
    FROM tournament_brackets tb
    WHERE tb.tournament_stage_id = _stage_id
      AND tb.round = next_round
      AND tb."group" = _group
      AND (tb.tournament_team_id_1 = _team_id OR tb.tournament_team_id_2 = _team_id)
      AND tb.match_id IS NULL
    LIMIT 1;
    
    RETURN bracket_id;
END;
$$;

