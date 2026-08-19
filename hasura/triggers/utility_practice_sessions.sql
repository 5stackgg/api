CREATE OR REPLACE FUNCTION public.tbiu_utility_practice_sessions() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = now();

    IF NOT EXISTS (
        SELECT 1 FROM public.maps m WHERE m.name = NEW.map_name
    ) THEN
        RAISE EXCEPTION 'Unknown map: %', NEW.map_name USING ERRCODE = '22000';
    END IF;

    -- empty_since is what the reaper counts idle minutes from, so it must be
    -- cleared the moment anyone is on the server again. Leaving that to every
    -- caller is how a session gets reaped with people still in it.
    IF TG_OP = 'UPDATE' THEN
        IF NEW.last_occupied_at IS DISTINCT FROM OLD.last_occupied_at
           AND NEW.last_occupied_at IS NOT NULL THEN
            NEW.empty_since = NULL;
        END IF;

        IF NEW.status IN ('Ended', 'Failed')
           AND OLD.status NOT IN ('Ended', 'Failed') THEN
            NEW.expires_at = COALESCE(NEW.expires_at, now());
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_utility_practice_sessions ON public.utility_practice_sessions;
CREATE TRIGGER tbiu_utility_practice_sessions
    BEFORE INSERT OR UPDATE ON public.utility_practice_sessions
    FOR EACH ROW EXECUTE FUNCTION public.tbiu_utility_practice_sessions();
