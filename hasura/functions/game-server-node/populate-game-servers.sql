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

    -- A dedicated server keeps its ports only while they are one of the
    -- range's pairs. Any other one, outside the range or across two of its
    -- pairs, takes the lowest pair no dedicated server holds.
    FOR dedicated_server IN
        SELECT s.id
        FROM servers s
        WHERE s.game_server_node_id = _game_server_node_id
          AND s.is_dedicated = true
          AND NOT EXISTS (
              SELECT 1
              FROM generate_series(_start_port_range, _end_port_range - 1, 2) AS pair(port)
              WHERE pair.port = s.port
                AND pair.port + 1 = s.tv_port
          )
        ORDER BY s.port, s.id
    LOOP
        SELECT pair.port INTO available_port
        FROM generate_series(_start_port_range, _end_port_range - 1, 2) AS pair(port)
        WHERE NOT EXISTS (
            SELECT 1
            FROM servers s
            WHERE s.game_server_node_id = _game_server_node_id
              AND s.is_dedicated = true
              AND s.port = pair.port
              AND s.tv_port = pair.port + 1
        )
        ORDER BY pair.port
        LIMIT 1;

        IF available_port IS NULL THEN
            RAISE EXCEPTION 'The port range has no room for the dedicated servers on this node' USING ERRCODE = '22000';
        END IF;

        PERFORM set_config('fivestack.node_server_sync', 'true', true);
        UPDATE servers
        SET port = available_port, tv_port = available_port + 1
        WHERE id = dedicated_server.id;
        PERFORM set_config('fivestack.node_server_sync', 'false', true);
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