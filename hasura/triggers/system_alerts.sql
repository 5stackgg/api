DROP TRIGGER IF EXISTS y_tbu_system_alerts_last_changed_by ON public.system_alerts;
CREATE TRIGGER y_tbu_system_alerts_last_changed_by
    BEFORE UPDATE OF last_changed_by_steam_id ON public.system_alerts
    FOR EACH ROW EXECUTE FUNCTION public.tbu_last_changed_by_named();

DROP TRIGGER IF EXISTS z_tbiu_system_alerts_last_changed ON public.system_alerts;
CREATE TRIGGER z_tbiu_system_alerts_last_changed
    BEFORE INSERT OR UPDATE ON public.system_alerts
    FOR EACH ROW EXECUTE FUNCTION public.tbiu_stamp_last_changed(
        'type', 'title', 'message', 'is_active', 'dismissible', 'expires_at'
    );

DROP TRIGGER IF EXISTS taiu_system_alert_activations ON public.system_alerts;
CREATE TRIGGER taiu_system_alert_activations
    AFTER INSERT OR UPDATE OF is_active ON public.system_alerts
    FOR EACH ROW EXECUTE FUNCTION public.taiu_system_alert_activations();
