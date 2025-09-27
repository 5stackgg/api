CREATE OR REPLACE FUNCTION public.taiud_populate_game_servers()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    serverCount int = 0;
    game_port int;
    server_ip inet;
    is_region_lan boolean;
    dedicated_server RECORD;
    available_port int;
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
        UPDATE servers SET host = host(server_ip) WHERE game_server_node_id = NEW.id;
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

    delete from servers where game_server_node_id = NEW.id and is_dedicated = false;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    IF NEW.enabled = false OR NEW.start_port_range IS NULL OR NEW.end_port_range IS NULL OR NEW.public_ip IS NULL THEN
        RETURN NEW;
    END IF;
      
    -- Handle dedicated servers that are outside the new port range
    -- Find dedicated servers with ports outside the new range and reassign them
    -- Use a cursor to assign each dedicated server a unique port
    FOR dedicated_server IN 
        SELECT id, port, tv_port 
        FROM servers 
        WHERE game_server_node_id = NEW.id 
        AND is_dedicated = true 
        AND (port < NEW.start_port_range OR port >= NEW.end_port_range)
    LOOP
        -- Find the first available port for this dedicated server
        SELECT port INTO available_port
        FROM generate_series(NEW.start_port_range, NEW.end_port_range - 1, 2) AS port
        WHERE port NOT IN (
            SELECT s.port 
            FROM servers s 
            WHERE s.game_server_node_id = NEW.id 
            AND s.port IS NOT NULL
            AND s.id != dedicated_server.id  -- Exclude the current server being updated
        )
        ORDER BY port
        LIMIT 1;
        
        -- Update this dedicated server with the available port
        IF available_port IS NOT NULL THEN
            UPDATE servers 
            SET port = available_port, tv_port = available_port + 1
            WHERE id = dedicated_server.id;
        END IF;
    END LOOP;

    game_port = NEW.start_port_range;

    WHILE game_port < NEW.end_port_range LOOP
        serverCount = serverCount + 1;

        if exists (select 1 from servers where game_server_node_id = NEW.id and (port = game_port or tv_port = game_port or port = game_port + 1 or tv_port = game_port + 1)) then
            game_port = game_port + 2;
            continue;
        end if;

        INSERT INTO servers (host, label, rcon_password, port, tv_port, api_password, game_server_node_id, region)
        VALUES (host(server_ip), CONCAT('on-demand-', serverCount), gen_random_uuid()::text::bytea, game_port, game_port + 1, gen_random_uuid(), NEW.id, NEW.region);

        game_port = game_port + 2;
    END LOOP;

    RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS taiud_populate_game_servers ON public.game_server_nodes;
CREATE TRIGGER taiud_populate_game_servers AFTER INSERT OR UPDATE OR DELETE ON public.game_server_nodes FOR EACH ROW EXECUTE FUNCTION public.taiud_populate_game_servers();
