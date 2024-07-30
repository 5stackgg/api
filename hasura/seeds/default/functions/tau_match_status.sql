CREATE OR REPLACE FUNCTION public.tau_match_status() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    bracket tournament_brackets%ROWTYPE;
    parent_bracket tournament_brackets%ROWTYPE;
    winning_team_id UUID;
    bracket_spot_1 UUID;
BEGIN
    -- If there's no winning lineup, return the new row as is
    IF NEW.winning_lineup_id IS NULL THEN
        RETURN NEW;
    END IF;
    -- Select the current bracket
    SELECT * INTO bracket
    FROM tournament_brackets
    WHERE match_id = NEW.id
    LIMIT 1;
    -- If bracket is NULL, return the new row as is
    IF bracket IS NULL THEN
        RETURN NEW;
    END IF;
    -- Select the parent bracket
    SELECT * INTO parent_bracket
    FROM tournament_brackets
    WHERE id = bracket.parent_bracket_id
    LIMIT 1;
    -- If parent_bracket is NULL, return the new row as is
    IF parent_bracket IS NULL THEN
        RETURN NEW;
    END IF;
    -- Determine the winning team based on the winning lineup
    IF NEW.winning_lineup_id = NEW.lineup_1_id THEN
        winning_team_id = bracket.tournament_team_id_1;
    ELSE
        winning_team_id = bracket.tournament_team_id_2;
    END IF;
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
    -- Schedule the next match for the current bracket
    PERFORM schedule_tournament_match(bracket);
    RETURN NEW;
END;
$$;