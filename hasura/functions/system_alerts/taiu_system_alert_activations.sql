-- Keeps system_alert_activations: an alert going up opens a period, coming
-- down closes it. Expiry is client-side (an expired alert stays is_active and
-- the client stops showing it), so two expiry cases are handled here too:
-- turning off an alert that had already expired ends its period at the
-- expiry, not now, and putting an expired, still-active alert back up (a new
-- expires_at) closes the old period at its expiry and opens a new one.
CREATE OR REPLACE FUNCTION public.taiu_system_alert_activations() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _steam_id bigint := public.hasura_session_steam_id();
    _expired boolean := TG_OP = 'UPDATE'
        AND OLD.expires_at IS NOT NULL
        AND OLD.expires_at <= now();
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.is_active AND NEW.is_active THEN
        IF _expired AND (NEW.expires_at IS NULL OR NEW.expires_at > now()) THEN
            UPDATE public.system_alert_activations
               SET ended_at = GREATEST(started_at, OLD.expires_at)
             WHERE alert_id = NEW.id
               AND ended_at IS NULL;

            INSERT INTO public.system_alert_activations (alert_id, started_by_steam_id)
            VALUES (NEW.id, _steam_id)
            ON CONFLICT (alert_id) WHERE ended_at IS NULL DO NOTHING;
        END IF;
    ELSIF NEW.is_active AND (TG_OP = 'INSERT' OR NOT OLD.is_active) THEN
        INSERT INTO public.system_alert_activations (alert_id, started_by_steam_id)
        VALUES (NEW.id, _steam_id)
        ON CONFLICT (alert_id) WHERE ended_at IS NULL DO NOTHING;
    ELSIF TG_OP = 'UPDATE' AND OLD.is_active AND NOT NEW.is_active THEN
        -- An expired alert stopped showing at its expiry; whoever switches it
        -- off afterwards didn't end it.
        UPDATE public.system_alert_activations
           SET ended_at = CASE WHEN _expired
                               THEN GREATEST(started_at, OLD.expires_at)
                               ELSE now() END,
               ended_by_steam_id = CASE WHEN _expired THEN NULL ELSE _steam_id END
         WHERE alert_id = NEW.id
           AND ended_at IS NULL;
    END IF;

    RETURN NULL;
END;
$$;
