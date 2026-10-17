-- Keeps system_alert_activations: an alert going up opens a period, coming
-- down closes it. expires_at is not watched; an expired alert stays is_active
-- and the client stops showing it.
CREATE OR REPLACE FUNCTION public.taiu_system_alert_activations() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _steam_id bigint := public.hasura_session_steam_id();
BEGIN
    IF NEW.is_active AND (TG_OP = 'INSERT' OR NOT OLD.is_active) THEN
        INSERT INTO public.system_alert_activations (alert_id, started_by_steam_id)
        VALUES (NEW.id, _steam_id)
        ON CONFLICT (alert_id) WHERE ended_at IS NULL DO NOTHING;
    ELSIF TG_OP = 'UPDATE' AND OLD.is_active AND NOT NEW.is_active THEN
        UPDATE public.system_alert_activations
           SET ended_at = now(),
               ended_by_steam_id = _steam_id
         WHERE alert_id = NEW.id
           AND ended_at IS NULL;
    END IF;

    RETURN NULL;
END;
$$;
