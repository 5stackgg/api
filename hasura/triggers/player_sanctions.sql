CREATE OR REPLACE FUNCTION public.tau_player_sanctions() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.type = 'ban'
       AND OLD.deleted_at IS NULL
       AND NEW.deleted_at IS NOT NULL THEN
        UPDATE public.players
            SET vac_banned = false
            WHERE steam_id = NEW.player_steam_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_player_sanctions ON public.player_sanctions;
CREATE TRIGGER tau_player_sanctions AFTER UPDATE ON public.player_sanctions FOR EACH ROW EXECUTE FUNCTION public.tau_player_sanctions();
