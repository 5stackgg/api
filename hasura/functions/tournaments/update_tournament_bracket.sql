CREATE OR REPLACE FUNCTION public.update_tournament_bracket(match matches) RETURNS VOID
    LANGUAGE plpgsql
AS $$
DECLARE
    bracket tournament_brackets%ROWTYPE;
    winning_team_id UUID;
    losing_team_id UUID;
    tournament_id UUID;
BEGIN
    IF match.winning_lineup_id IS NULL THEN
        RETURN;
    END IF;

    SELECT * INTO bracket
    FROM tournament_brackets
    WHERE match_id = match.id
    LIMIT 1;

    IF bracket IS NULL THEN
        RETURN;
    END IF;

    IF match.winning_lineup_id = match.lineup_1_id THEN
        winning_team_id = bracket.tournament_team_id_1;
        losing_team_id = bracket.tournament_team_id_2;
    ELSE
        winning_team_id = bracket.tournament_team_id_2;
        losing_team_id = bracket.tournament_team_id_1;
    END IF;

    update tournament_brackets
    SET finished = true
    WHERE id = bracket.id;

    IF bracket.parent_bracket_id IS NOT NULL THEN
        PERFORM public.assign_team_to_bracket_slot(bracket.parent_bracket_id, winning_team_id);
    END IF;

    IF bracket.loser_parent_bracket_id IS NOT NULL THEN
        PERFORM public.assign_team_to_bracket_slot(bracket.loser_parent_bracket_id, losing_team_id);
    END IF;

    SELECT ts.tournament_id INTO tournament_id
    FROM tournament_stages ts 
    WHERE ts.id = bracket.tournament_stage_id;
    
    IF tournament_id IS NOT NULL THEN
        PERFORM check_tournament_finished(tournament_id);
    END IF;

    RETURN;
END;
$$;