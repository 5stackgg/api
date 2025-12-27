CREATE OR REPLACE FUNCTION public.opponent_finished_previous_round(
    _opponent_team_id uuid,
    _stage_id uuid,
    _current_round int,
    _group int
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    bracket_id uuid;
BEGIN
    SELECT tb.id INTO bracket_id
    FROM tournament_brackets tb
    INNER JOIN matches m ON m.id = tb.match_id
    WHERE tb.tournament_stage_id = _stage_id
      AND tb.round = _current_round
      AND tb."group" = _group
      AND (tb.tournament_team_id_1 = _opponent_team_id OR tb.tournament_team_id_2 = _opponent_team_id)
      AND m.winning_lineup_id IS NOT NULL
    LIMIT 1;
    
    RETURN bracket_id IS NOT NULL;
END;
$$;

