CREATE OR REPLACE FUNCTION public.populate_game_servers(
    _game_server_node_id text,
    _start_port_range integer,
    _end_port_range integer,
    _server_ip inet,
    _region text
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    serverCount integer := 0;
    game_port integer;
    dedicated_server RECORD;
    available_port integer;
    server_enabled boolean := true;
BEGIN

    raise notice 'populate_game_servers: _game_server_node_id: %', _game_server_node_id;
    raise notice 'populate_game_servers: _start_port_range: %', _start_port_range;
    raise notice 'populate_game_servers: _end_port_range: %', _end_port_range;
    raise notice 'populate_game_servers: _server_ip: %', _server_ip;
    raise notice 'populate_game_servers: _region: %', _region;

    -- Handle dedicated servers that are outside the new port range
    FOR dedicated_server IN 
        SELECT id, port, tv_port 
        FROM servers 
        WHERE game_server_node_id = _game_server_node_id 
          AND is_dedicated = true 
          AND (port < _start_port_range OR port >= _end_port_range)
    LOOP
        -- Find the first available port for this dedicated server
        SELECT port INTO available_port
        FROM generate_series(_start_port_range, _end_port_range - 1, 2) AS port
        WHERE port NOT IN (
            SELECT s.port 
            FROM servers s 
            WHERE s.game_server_node_id = _game_server_node_id 
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

    game_port := _start_port_range;

    WHILE game_port < _end_port_range LOOP
        serverCount := serverCount + 1;
        server_enabled :=true;

        IF EXISTS (
            SELECT 1
            FROM servers
            WHERE game_server_node_id = _game_server_node_id
              AND (
                port = game_port OR
                tv_port = game_port OR
                port = game_port + 1 OR
                tv_port = game_port + 1
              ) 
              and enabled = true
        ) THEN
            server_enabled := false;
        END IF;

        INSERT INTO servers (
            host,
            label,
            rcon_password,
            port,
            tv_port,
            api_password,
            game_server_node_id,
            region,
            enabled
        )
        VALUES (
            host(_server_ip),
            CONCAT('on-demand-', serverCount),
            gen_random_uuid()::text::bytea,
            game_port,
            game_port + 1,
            gen_random_uuid(),
            _game_server_node_id,
            _region,
            server_enabled
        );

        game_port := game_port + 2;
    END LOOP;
END;
$$;