CREATE OR REPLACE FUNCTION public.opponent_finished_previous_round(
    _opponent_team_id uuid,
    _stage_id uuid,
    _current_round int,
    _group int
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    has_bracket boolean;
    bracket_id uuid;
BEGIN
    -- Did the opponent have any bracket entry in the previous round of this group?
    -- In odd-sized round robin groups, one team sits out each round (no bracket row).
    -- Sitting out is not a wait condition, so treat it as already "finished".
    SELECT EXISTS (
        SELECT 1 FROM tournament_brackets tb
        WHERE tb.tournament_stage_id = _stage_id
          AND tb.round = _current_round
          AND tb."group" = _group
          AND (tb.tournament_team_id_1 = _opponent_team_id OR tb.tournament_team_id_2 = _opponent_team_id)
    ) INTO has_bracket;

    IF NOT has_bracket THEN
        RETURN true;
    END IF;

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

