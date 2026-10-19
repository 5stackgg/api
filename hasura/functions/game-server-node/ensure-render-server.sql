-- A GPU-only node takes no matches and has no port range, but a utility render
-- still needs a practice server beside its GPU: the render pod films it over
-- the loopback they share. The booking makes that server's slot the first time
-- it needs one, in the render's own region -- a server needs a region, and a
-- GPU-only node has none to give it. Nothing else books the slot, because
-- every other booking wants a node that takes matches.
--
-- Its ports are only ever dialled on 127.0.0.1, so no range is needed; the
-- first pair from 27015 that no server on the node already holds will do.
CREATE OR REPLACE FUNCTION public.ensure_render_server(
    _game_server_node_id text,
    _region text
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    node game_server_nodes;
    render_port integer;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('ensure_render_server:' || _game_server_node_id));

    -- Shared, so a node being switched to take matches commits first and is
    -- read as it ends up: a slot made under it would be booked by matchmaking.
    SELECT * INTO node FROM game_server_nodes WHERE id = _game_server_node_id FOR SHARE;

    IF node.id IS NULL
       OR node.enabled IS NOT TRUE
       OR node.gpu IS NOT TRUE
       OR node.enabled_for_match_making
       OR (node.start_port_range IS NOT NULL AND node.end_port_range IS NOT NULL) THEN
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1 FROM servers
        WHERE game_server_node_id = _game_server_node_id
          AND is_dedicated = false
    ) THEN
        RETURN;
    END IF;

    SELECT pair.port INTO render_port
    FROM generate_series(27015, 65533, 2) AS pair(port)
    WHERE NOT EXISTS (
        SELECT 1
        FROM servers s
        WHERE s.game_server_node_id = _game_server_node_id
          AND (
            s.port IN (pair.port, pair.port + 1) OR
            s.tv_port IN (pair.port, pair.port + 1)
          )
    )
    ORDER BY pair.port
    LIMIT 1;

    INSERT INTO servers (
        host,
        label,
        rcon_password,
        port,
        tv_port,
        api_password,
        game_server_node_id,
        region
    )
    VALUES (
        COALESCE(host(COALESCE(node.public_ip, node.lan_ip)), '127.0.0.1'),
        'render',
        gen_random_uuid()::text::bytea,
        render_port,
        render_port + 1,
        gen_random_uuid(),
        _game_server_node_id,
        _region
    );
END;
$$;
