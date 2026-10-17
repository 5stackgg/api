CREATE OR REPLACE FUNCTION public.taiud_populate_game_servers()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    server_ip inet;
    is_region_lan boolean;
BEGIN
    select is_lan into is_region_lan from server_regions where value = NEW.region;

    if(is_region_lan) then
        server_ip = NEW.lan_ip;
    else
        server_ip = NEW.public_ip;
    end if;

    IF TG_OP = 'UPDATE' AND (
        OLD.lan_ip != NEW.lan_ip OR
        OLD.public_ip != NEW.public_ip 
    ) THEN
        UPDATE servers SET host = host(server_ip) WHERE game_server_node_id = NEW.id AND is_dedicated = false;
    END IF;

    -- A dedicated server's address follows the node at any time: its pod never
    -- reads it. Its region waits for the ongoing-match check below, because a
    -- region change rebuilds the server.
    IF TG_OP = 'UPDATE' AND (
        OLD.lan_ip IS DISTINCT FROM NEW.lan_ip OR
        OLD.public_ip IS DISTINCT FROM NEW.public_ip
    ) THEN
        PERFORM set_config('fivestack.node_server_sync', 'true', true);
        UPDATE servers
        SET host = host(server_ip)
        WHERE game_server_node_id = NEW.id AND is_dedicated = true
          AND host IS DISTINCT FROM host(server_ip) AND server_ip IS NOT NULL;
        PERFORM set_config('fivestack.node_server_sync', 'false', true);
    END IF;

    IF TG_OP = 'UPDATE' AND (
        NEW.enabled = true AND
        (
            OLD.enabled = NEW.enabled AND
            OLD.region = NEW.region AND
            OLD.start_port_range = NEW.start_port_range AND
            OLD.end_port_range = NEW.end_port_range
        )
    ) THEN
        RETURN NEW;
    END IF;

    IF TG_OP != 'INSERT' THEN
        IF EXISTS (SELECT 1 FROM servers WHERE game_server_node_id = NEW.id AND reserved_by_match_id IS NOT NULL) THEN
            RAISE EXCEPTION 'Can not change node details while matches are ongoing. It is recommended to disable node to prevent further usage.' USING ERRCODE = '22000';
        END IF;
    END IF;

    -- The on-demand servers are rebuilt below. Dedicated ones are not, so they
    -- take the node's region and address here. A disabled node gets this far
    -- on every heartbeat, which is no reason to rebuild a server.
    IF TG_OP = 'UPDATE' AND (
        OLD.enabled IS DISTINCT FROM NEW.enabled OR
        OLD.region IS DISTINCT FROM NEW.region OR
        OLD.start_port_range IS DISTINCT FROM NEW.start_port_range OR
        OLD.end_port_range IS DISTINCT FROM NEW.end_port_range
    ) THEN
        PERFORM set_config('fivestack.node_server_sync', 'true', true);
        UPDATE servers
        SET host = COALESCE(host(server_ip), host), region = NEW.region
        WHERE game_server_node_id = NEW.id AND is_dedicated = true
          AND (host, region) IS DISTINCT FROM (COALESCE(host(server_ip), host), NEW.region);
        PERFORM set_config('fivestack.node_server_sync', 'false', true);
    END IF;

    delete from servers where game_server_node_id = NEW.id and is_dedicated = false;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    IF NEW.enabled = false OR NEW.start_port_range IS NULL OR NEW.end_port_range IS NULL OR NEW.public_ip IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM populate_game_servers(NEW.id, NEW.start_port_range, NEW.end_port_range, server_ip, NEW.region);

    RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS taiud_populate_game_servers ON public.game_server_nodes;
CREATE TRIGGER taiud_populate_game_servers AFTER INSERT OR UPDATE OR DELETE ON public.game_server_nodes FOR EACH ROW EXECUTE FUNCTION public.taiud_populate_game_servers();

DROP TRIGGER IF EXISTS y_tbu_game_server_nodes_last_changed_by ON public.game_server_nodes;
CREATE TRIGGER y_tbu_game_server_nodes_last_changed_by
    BEFORE UPDATE OF last_changed_by_steam_id ON public.game_server_nodes
    FOR EACH ROW EXECUTE FUNCTION public.tbu_last_changed_by_named();

DROP TRIGGER IF EXISTS z_tbiu_game_server_nodes_last_changed ON public.game_server_nodes;
CREATE TRIGGER z_tbiu_game_server_nodes_last_changed
    BEFORE INSERT OR UPDATE ON public.game_server_nodes
    FOR EACH ROW EXECUTE FUNCTION public.tbiu_stamp_last_changed(
        'accepting_new_matches', 'cs2_video_settings', 'demo_network_limiter',
        'enabled', 'enabled_for_match_making', 'end_port_range',
        'gpu_demos_enabled', 'gpu_rendering_enabled', 'gpu_streaming_enabled',
        'label', 'pin_build_id', 'pin_plugin_runtime', 'pin_plugin_version',
        'region', 'start_port_range'
    );
