CREATE OR REPLACE FUNCTION public.get_veto_picking_lineup_id(_match public.matches) RETURNS uuid
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    lineup_id uuid;
    total_picks int;
    round_num int;
    starting_team int;
    picks_made int;
    team int;
BEGIN
    IF _match.status != 'Veto' THEN
        RETURN NULL;
    END IF;
    -- Count the total number of picks made for the match
    SELECT COUNT(*) INTO total_picks
    FROM match_veto_picks mvp
    WHERE mvp.match_id = _match.id;
    -- Calculate the round number
    round_num := floor(total_picks / 6);
    -- Determine the starting team based on the round number
    IF round_num % 2 = 0 THEN
        starting_team := 1;
    ELSE
        starting_team := 2;
    END IF;
    -- Determine the team based on the number of picks made within the round
    picks_made := total_picks % 6;
    IF picks_made < 4 THEN
        IF (starting_team = 1 AND picks_made % 2 = 0) OR
           (starting_team = 2 AND picks_made % 2 <> 0) THEN
            team := 1;
        ELSE
            team := 2;
        END IF;
    ELSE
        -- After the fourth pick within a round, switch the teams
        IF (starting_team = 1 AND picks_made % 2 = 0) OR
           (starting_team = 2 AND picks_made % 2 <> 0) THEN
            team := 2;
        ELSE
            team := 1;
        END IF;
    END IF;
    -- Determine the lineup ID based on the team
    IF team = 1 THEN
       RETURN _match.lineup_1_id;
    ELSE
       RETURN _match.lineup_2_id;
    END IF;
END;
$$;