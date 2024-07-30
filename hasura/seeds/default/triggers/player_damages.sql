CREATE OR REPLACE FUNCTION public.tbiu_player_damages() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
     total_damage integer;
BEGIN
    IF NEW.damage > 100 THEN
        NEW.damage = 100;
    END IF;

    -- Calculate the total damage for the attacked player in the same round and match
    SELECT COALESCE(SUM(damage), 0) INTO total_damage
    FROM player_damages
    WHERE
        round = NEW.round
        AND match_id = NEW.match_id
        AND match_map_id = NEW.match_map_id
        AND attacked_steam_id = NEW.attacked_steam_id;
    -- If the total damage plus the new damage exceeds 100, adjust the new damage
    IF total_damage + NEW.damage > 100 THEN
        NEW.damage := 100 - total_damage;
    END IF;

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_player_damages ON public.player_damages;
CREATE TRIGGER tbiu_player_damages BEFORE INSERT OR UPDATE ON public.player_damages FOR EACH ROW EXECUTE FUNCTION public.tbiu_player_damages();
