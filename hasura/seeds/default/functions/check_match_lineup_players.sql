CREATE OR REPLACE FUNCTION public.check_match_lineup_players(match_lineup_player match_lineup_players) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    _match_id uuid;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF match_lineup_players.captain = true THEN
            UPDATE match_lineup_players
            SET captain = false
            WHERE match_lineup_id = match_lineup_players.match_lineup_id AND steam_id != match_lineup_players.steam_id;
        END IF;
        RETURN;
    END IF;
    IF match_lineup_players.steam_id IS NULL AND match_lineup_players.discord_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'steam_id or discord_id is required';
    END IF;
    SELECT ml.match_id INTO _match_id
    FROM v_match_lineups ml
    WHERE ml.id = match_lineup_players.match_lineup_id;
	IF EXISTS (
        SELECT 1
        FROM match_lineup_players mlp
        INNER JOIN v_match_lineups ml ON ml.id = mlp.match_lineup_id
        WHERE mlp.steam_id = match_lineup_players.steam_id and ml.match_id = _match_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Player is already added to match';
    END IF;
    IF match_lineup_players.captain = true THEN
        UPDATE match_lineup_players
        SET captain = false
        WHERE match_lineup_id = match_lineup_players.match_lineup_id AND steam_id != match_lineup_players.steam_id;
    END IF;
END;
$$;