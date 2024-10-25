CREATE OR REPLACE FUNCTION public.pick_captain(_match_lineup_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    captain_count INT;
    new_captain_id bigint;
BEGIN
    SELECT COUNT(*) INTO captain_count
    FROM match_lineup_players
    WHERE match_lineup_id = _match_lineup_id AND captain = true;

    -- RAISE EXCEPTION 'Cannot add players: not in picking players status captain_count %', captain_count USING ERRCODE = '22000';

    IF captain_count = 0 THEN
        -- Select the first player (by ID) to be the new captain
        SELECT steam_id INTO new_captain_id
        FROM match_lineup_players
        WHERE match_lineup_id = _match_lineup_id
        ORDER BY steam_id
        LIMIT 1;

        -- If there's at least one player left, make them captain
        IF new_captain_id IS NOT NULL THEN
            UPDATE match_lineup_players
            SET captain = true
            WHERE match_lineup_id = _match_lineup_id AND steam_id = new_captain_id;
        END IF;
    END IF;
END;
$$;
