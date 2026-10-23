CREATE OR REPLACE FUNCTION public.tau_player_sanctions() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.type = 'ban'
       AND NEW.sanctioned_by_steam_id IS NULL
       AND NEW.reason LIKE 'Auto: Steam%'
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

-- A Hasura user session acts with its own role while its player still holds
-- it, and the api lifts a sanction inside its actor's session; otherwise an
-- insert acts as its sanctioner, and one with no sanctioner is the system's own
-- ban. An update is only checked when it changes the sanction itself (its type,
-- its end or its removal), so the FK cascade that clears a deleted sanctioner
-- passes, and so does an update with no session at all: the system lifting or
-- expiring a sanction.
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
       AND NEW.type IS NOT DISTINCT FROM OLD.type
       AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at THEN
        RETURN NEW;
    END IF;

    IF _session_role IS NOT NULL AND _session_role <> 'admin' THEN
        IF NOT public.session_role_is_current() THEN
            RAISE EXCEPTION 'Your role has changed, reload and try again'
                USING ERRCODE = '22000';
        END IF;
        _actor_role := _session_role;
    ELSIF TG_OP = 'INSERT' AND NEW.sanctioned_by_steam_id IS NOT NULL THEN
        SELECT role::text INTO _actor_role
            FROM public.players
            WHERE steam_id = NEW.sanctioned_by_steam_id;
    ELSE
        RETURN NEW;
    END IF;

    IF NOT public.can_sanction_player(_actor_role, NEW.player_steam_id) THEN
        RAISE EXCEPTION 'You cannot sanction, or lift a sanction on, a player whose role is equal to or above your own'
            USING ERRCODE = '22000';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_player_sanctions ON public.player_sanctions;
CREATE TRIGGER tbiu_player_sanctions BEFORE INSERT OR UPDATE ON public.player_sanctions FOR EACH ROW EXECUTE FUNCTION public.tbiu_player_sanctions();
