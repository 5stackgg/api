CREATE OR REPLACE FUNCTION public.update_tournament_bracket(match matches) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    bracket tournament_brackets%ROWTYPE;
    parent_bracket tournament_brackets%ROWTYPE;
    loser_parent_bracket tournament_brackets%ROWTYPE;
    winning_team_id UUID;
    losing_team_id UUID;
    bracket_spot_1 UUID;
    tournament_id UUID;
BEGIN
    -- If there's no winning lineup, return the match row as is
    IF match.winning_lineup_id IS NULL THEN
        RETURN;
    END IF;

    -- Select the current bracket
    SELECT * INTO bracket
    FROM tournament_brackets
    WHERE match_id = match.id
    LIMIT 1;

    -- If bracket is NULL, return the match row as is
    IF bracket IS NULL THEN
        RETURN;
    END IF;

    -- Select the parent bracket (for winners path)
    SELECT * INTO parent_bracket
    FROM tournament_brackets
    WHERE id = bracket.parent_bracket_id
    LIMIT 1;

    -- Determine the winning team based on the winning lineup
    IF match.winning_lineup_id = match.lineup_1_id THEN
        winning_team_id = bracket.tournament_team_id_1;
        losing_team_id = bracket.tournament_team_id_2;
    ELSE
        winning_team_id = bracket.tournament_team_id_2;
        losing_team_id = bracket.tournament_team_id_1;
    END IF;

    -- Advance winner if a winners parent exists
    IF parent_bracket.id IS NOT NULL THEN
        -- Find the spot in the parent bracket where the winning team should go
        SELECT tb.id INTO bracket_spot_1
        FROM tournament_brackets tb
        WHERE tb.parent_bracket_id = parent_bracket.id
        AND tb.match_number = (
            SELECT MIN(tb2.match_number)
            FROM tournament_brackets tb2
            WHERE tb2.parent_bracket_id = parent_bracket.id
        );

        -- Update the parent bracket with the winning team
        IF bracket_spot_1 = bracket.id THEN
            UPDATE tournament_brackets SET tournament_team_id_1 = winning_team_id WHERE id = parent_bracket.id;
        ELSE
            UPDATE tournament_brackets SET tournament_team_id_2 = winning_team_id WHERE id = parent_bracket.id;
        END IF;
    END IF;
    
    -- Schedule the next match for the current bracket
    PERFORM schedule_tournament_match(bracket);

    -- If this bracket feeds a losers bracket, advance the losing team
    IF bracket.loser_parent_bracket_id IS NOT NULL THEN
        SELECT * INTO loser_parent_bracket
        FROM tournament_brackets
        WHERE id = bracket.loser_parent_bracket_id
        LIMIT 1;

        IF loser_parent_bracket.id IS NOT NULL THEN
            -- Prefer to place the loser into the empty slot
            IF loser_parent_bracket.tournament_team_id_1 IS NULL THEN
                UPDATE tournament_brackets
                SET tournament_team_id_1 = losing_team_id
                WHERE id = loser_parent_bracket.id;
            ELSIF loser_parent_bracket.tournament_team_id_2 IS NULL THEN
                UPDATE tournament_brackets
                SET tournament_team_id_2 = losing_team_id
                WHERE id = loser_parent_bracket.id;
            ELSE
                -- Fallback: for first-round WB losers pairing, use match_number parity for stable placement
                IF bracket.round = 1 THEN
                    IF bracket.match_number % 2 = 1 THEN
                        UPDATE tournament_brackets
                        SET tournament_team_id_1 = losing_team_id
                        WHERE id = loser_parent_bracket.id;
                    ELSE
                        UPDATE tournament_brackets
                        SET tournament_team_id_2 = losing_team_id
                        WHERE id = loser_parent_bracket.id;
                    END IF;
                END IF;
            END IF;
        END IF;
    END IF;

    -- Get tournament_id from tournament_stages and check if tournament is finished
    SELECT ts.tournament_id INTO tournament_id
    FROM tournament_stages ts 
    WHERE ts.id = bracket.tournament_stage_id;
    
    IF tournament_id IS NOT NULL THEN
        PERFORM check_tournament_finished(tournament_id);
    END IF;

    RETURN;
END;
$$;