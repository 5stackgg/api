CREATE OR REPLACE FUNCTION public.tau_player_sanctions() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.type = 'ban'
       AND NEW.sanctioned_by_steam_id IS NULL
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

-- A Hasura user session acts with its own role; otherwise an insert acts as
-- its sanctioner, and one with no sanctioner is the system's own ban. An
-- update is only checked when it changes the sanction itself, so the FK
-- cascade that clears a deleted sanctioner and the api lifting a sanction pass.
CREATE OR REPLACE FUNCTION public.tbiu_player_sanctions() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _session_role text := NULLIF(current_setting('hasura.user', true), '')::jsonb ->> 'x-hasura-role';
    _actor_role text;
BEGIN
    IF NEW.type = 'warning' THEN
        NEW.remove_sanction_date := NULL;
    END IF;

    IF TG_OP = 'UPDATE'
       AND NEW.remove_sanction_date IS NOT DISTINCT FROM OLD.remove_sanction_date
       AND NEW.type IS NOT DISTINCT FROM OLD.type THEN
        RETURN NEW;
    END IF;

    IF _session_role IS NOT NULL AND _session_role <> 'admin' THEN
        _actor_role := _session_role;
    ELSIF TG_OP = 'INSERT' AND NEW.sanctioned_by_steam_id IS NOT NULL THEN
        SELECT role::text INTO _actor_role
            FROM public.players
            WHERE steam_id = NEW.sanctioned_by_steam_id;
    ELSE
        RETURN NEW;
    END IF;

    IF NOT public.can_sanction_player(_actor_role, NEW.player_steam_id) THEN
        RAISE EXCEPTION 'You cannot sanction a player whose role is equal to or above your own'
            USING ERRCODE = '22000';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_player_sanctions ON public.player_sanctions;
CREATE TRIGGER tbiu_player_sanctions BEFORE INSERT OR UPDATE ON public.player_sanctions FOR EACH ROW EXECUTE FUNCTION public.tbiu_player_sanctions();
