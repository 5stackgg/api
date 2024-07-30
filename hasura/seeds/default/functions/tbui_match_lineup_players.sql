CREATE OR REPLACE FUNCTION public.tbui_match_lineup_players() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    _match_id uuid;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.captain = true THEN
            UPDATE match_lineup_players
            SET captain = false
            WHERE match_lineup_id = NEW.match_lineup_id AND steam_id != NEW.steam_id;
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.steam_id IS NULL AND NEW.discord_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'steam_id or discord_id is required';
    END IF;
    SELECT ml.match_id INTO _match_id
    FROM v_match_lineups ml
    WHERE ml.id = NEW.match_lineup_id;
	IF EXISTS (
        SELECT 1
        FROM match_lineup_players mlp
        INNER JOIN v_match_lineups ml ON ml.id = mlp.match_lineup_id
        WHERE mlp.steam_id = NEW.steam_id and ml.match_id = _match_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Player is already added to match';
    END IF;
    IF NEW.captain = true THEN
        UPDATE match_lineup_players
        SET captain = false
        WHERE match_lineup_id = NEW.match_lineup_id AND steam_id != NEW.steam_id;
    END IF;
    RETURN NEW;
END;
$$;