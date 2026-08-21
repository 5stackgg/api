CREATE OR REPLACE FUNCTION public.get_map_veto_picking_lineup_id(
    match public.matches
) RETURNS uuid
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    vetoPattern text[];
    action_index int;
    next_action text;
    turn_index int;
    picks_made int;
    current_team int;
    last_pick_lineup uuid;
BEGIN
    IF match.status != 'Veto' THEN
        RETURN NULL;
    END IF;

    vetoPattern := get_map_veto_pattern(match);

    SELECT COUNT(*) + 1 INTO action_index
    FROM match_map_veto_picks
    WHERE match_id = match.id;

    next_action := vetoPattern[action_index];

    IF next_action = 'Side' THEN
        SELECT mvp.match_lineup_id
        INTO last_pick_lineup
        FROM match_map_veto_picks mvp
        WHERE mvp.match_id = match.id
          AND mvp.type = 'Pick'
        ORDER BY mvp.created_at DESC
        LIMIT 1;

        IF last_pick_lineup IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Side selection requested but no prior Pick exists';
        END IF;

        IF last_pick_lineup = match.lineup_1_id THEN
            RETURN match.lineup_2_id;
        ELSE
            RETURN match.lineup_1_id;
        END IF;
    END IF;

    SELECT COUNT(*) INTO turn_index
    FROM match_map_veto_picks
    WHERE match_id = match.id
      AND type IN ('Ban', 'Pick', 'Decider');

    SELECT COUNT(*) INTO picks_made
    FROM match_map_veto_picks
    WHERE match_id = match.id
      AND type = 'Pick';

    -- Turns alternate, and every completed pair of picks reverses who leads, so
    -- the picks snake: lineup 1, lineup 2, lineup 2, lineup 1. Without the
    -- reverse the team that opens the veto takes every odd pick and the last
    -- ban before the decider.
    IF (picks_made / 2) % 2 = 1 THEN
        current_team := CASE WHEN turn_index % 2 = 0 THEN 2 ELSE 1 END;
    ELSE
        current_team := CASE WHEN turn_index % 2 = 0 THEN 1 ELSE 2 END;
    END IF;

    IF current_team = 1 THEN
        RETURN match.lineup_1_id;
    ELSE
        RETURN match.lineup_2_id;
    END IF;
END;
$$;
