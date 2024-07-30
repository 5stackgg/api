
CREATE OR REPLACE FUNCTION public.tbiu_player_damages() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.damage > 100 THEN
        NEW.damage = 100;
    END IF;

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_player_damages ON public.player_damages;
CREATE TRIGGER tbiu_player_damages BEFORE INSERT OR UPDATE ON public.player_damages FOR EACH ROW EXECUTE FUNCTION public.tbiu_player_damages();
