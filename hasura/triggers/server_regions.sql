CREATE OR REPLACE FUNCTION public.tau_validate_lan_regions()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    server_node record;
    server_ip inet;
BEGIN
    IF(NEW.is_lan != OLD.is_lan) then
        FOR server_node IN SELECT * FROM game_server_nodes WHERE region = NEW.value LOOP
            IF(NEW.is_lan) THEN
                server_ip = server_node.lan_ip;
            ELSE
                server_ip = server_node.public_ip;
            END IF;

            UPDATE servers SET host = host(server_ip) WHERE game_server_node_id = server_node.id AND is_dedicated = false;

            PERFORM set_config('fivestack.node_server_sync', 'true', true);
            UPDATE servers
            SET host = host(server_ip)
            WHERE game_server_node_id = server_node.id AND is_dedicated = true
              AND host IS DISTINCT FROM host(server_ip) AND server_ip IS NOT NULL;
            PERFORM set_config('fivestack.node_server_sync', 'false', true);
        END LOOP;
    END IF;
    
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_validate_lan_regions ON public.server_regions;
CREATE TRIGGER tau_validate_lan_regions AFTER UPDATE ON public.server_regions FOR EACH ROW EXECUTE FUNCTION public.tau_validate_lan_regions();

CREATE OR REPLACE FUNCTION public.tbiu_server_regions()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.is_lan = true AND NEW.steam_relay = true AND OLD.steam_relay = false THEN
        RAISE EXCEPTION 'Cannot enable Steam relay on LAN regions' USING ERRCODE = '22000';
    END IF;
    
    IF NEW.is_lan = true AND NEW.steam_relay = true THEN
        NEW.steam_relay = false;
    END IF;
    
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_server_regions ON public.server_regions;
CREATE TRIGGER tbiu_server_regions BEFORE INSERT OR UPDATE ON public.server_regions FOR EACH ROW EXECUTE FUNCTION public.tbiu_server_regions();

-- Runs after tbiu_server_regions, which turns Steam relay back off on a LAN
-- region.
DROP TRIGGER IF EXISTS y_tbu_server_regions_last_changed_by ON public.server_regions;
CREATE TRIGGER y_tbu_server_regions_last_changed_by
    BEFORE UPDATE OF last_changed_by_steam_id ON public.server_regions
    FOR EACH ROW EXECUTE FUNCTION public.tbu_last_changed_by_named();

DROP TRIGGER IF EXISTS z_tbiu_server_regions_last_changed ON public.server_regions;
CREATE TRIGGER z_tbiu_server_regions_last_changed
    BEFORE INSERT OR UPDATE ON public.server_regions
    FOR EACH ROW EXECUTE FUNCTION public.tbiu_stamp_last_changed(
        'description', 'is_lan', 'steam_relay', 'value'
    );
