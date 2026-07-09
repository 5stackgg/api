CREATE OR REPLACE FUNCTION public.taiu_settings()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    server_node record;
    server_ip inet;
BEGIN
    IF(NEW.name = 'update_map_pools' and NEW.value = 'true') then
        PERFORM update_map_pools();
    END IF;

    -- Changing the substitute count re-balances every team's roster statuses.
    IF NEW.name = 'public.team_max_subs'
       AND (TG_OP = 'INSERT' OR NEW.value IS DISTINCT FROM OLD.value) THEN
        PERFORM public.rebalance_all_team_rosters();
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS taiu_settings ON public.settings;
CREATE TRIGGER taiu_settings AFTER INSERT OR UPDATE ON public.settings FOR EACH ROW EXECUTE FUNCTION public.taiu_settings();
