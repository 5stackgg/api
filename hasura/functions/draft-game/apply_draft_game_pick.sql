CREATE OR REPLACE FUNCTION public.apply_draft_game_pick(pick public.draft_game_picks) RETURNS VOID
    LANGUAGE plpgsql
AS $$
DECLARE
    game public.draft_games;
    v_order int;
    undrafted_count int;
    last_steam bigint;
    target_lineup int;
    per_team int;
    next_lineup int;
BEGIN
    -- Place the picked player onto the captain's side; pick_order is the
    -- player's slot within that lineup (the captain already occupies slot 1).
    SELECT count(*) INTO v_order
    FROM draft_game_players
    WHERE draft_game_id = pick.draft_game_id AND lineup = pick.lineup;

    UPDATE draft_game_players
    SET lineup = pick.lineup, pick_order = v_order
    WHERE draft_game_id = pick.draft_game_id AND steam_id = pick.picked_steam_id;

    SELECT * INTO game FROM draft_games WHERE id = pick.draft_game_id;
    per_team := game.capacity / 2;

    SELECT count(*) INTO undrafted_count
    FROM draft_game_players
    WHERE draft_game_id = pick.draft_game_id AND lineup IS NULL;

    -- Auto-assign the final player: there is only one side with room left, so
    -- there is nothing to choose. Never make a captain pick the last option.
    IF undrafted_count = 1 THEN
        SELECT steam_id INTO last_steam
        FROM draft_game_players
        WHERE draft_game_id = pick.draft_game_id AND lineup IS NULL;

        IF (
            SELECT count(*) FROM draft_game_players
            WHERE draft_game_id = pick.draft_game_id AND lineup = 1
        ) < per_team THEN
            target_lineup := 1;
        ELSE
            target_lineup := 2;
        END IF;

        SELECT count(*) INTO v_order
        FROM draft_game_players
        WHERE draft_game_id = pick.draft_game_id AND lineup = target_lineup;

        UPDATE draft_game_players
        SET lineup = target_lineup, pick_order = v_order
        WHERE draft_game_id = pick.draft_game_id AND steam_id = last_steam;

        UPDATE draft_games
        SET status = 'CreatingMatch', current_pick_lineup = NULL
        WHERE id = pick.draft_game_id;
        RETURN;
    END IF;

    IF undrafted_count = 0 THEN
        UPDATE draft_games
        SET status = 'CreatingMatch', current_pick_lineup = NULL
        WHERE id = pick.draft_game_id;
        RETURN;
    END IF;

    -- Advance the turn to the next captain per the SQL-driven pattern.
    SELECT * INTO game FROM draft_games WHERE id = pick.draft_game_id;
    next_lineup := get_draft_game_picking_lineup_id(game);

    UPDATE draft_games
    SET current_pick_lineup = next_lineup
    WHERE id = pick.draft_game_id;

    RETURN;
END;
$$;
