CREATE OR REPLACE FUNCTION public.get_server_connection_string(server public.servers, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    connection_string text;
    min_role_to_connect text;
BEGIN
    -- A disabled server can still be online (external servers keep running),
    -- so gate on connected rather than enabled.
    IF server.connected = false OR server.type IN ('Ranked', 'Practice') OR server.host IS NULL OR server.port IS NULL THEN
        RETURN NULL;
    END IF;

    -- A restricted server's connect info is also what lists it for guests
    -- and players, so returning nothing hides it from everyone not allowed.
    IF NOT can_connect_to_server(server, hasura_session) THEN
        RETURN NULL;
    END IF;

    connection_string := CONCAT('connect ', get_server_host(server));

    IF NULLIF(server.connect_password, '') IS NULL THEN
        RETURN connection_string;
    END IF;

    min_role_to_connect := get_setting('dedicated_servers_min_role_to_connect', 'user');
    
    IF NOT is_above_role(min_role_to_connect, hasura_session) THEN
        RETURN NULL;
    END IF; 

    RETURN CONCAT(connection_string, '; password ', server.connect_password);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_server_connection_link(server public.servers, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    server_host text;
    min_role_to_connect text;
BEGIN
    -- A disabled server can still be online (external servers keep running),
    -- so gate on connected rather than enabled.
    IF server.connected = false OR server.type IN ('Ranked', 'Practice') OR NULLIF(server.connect_password, '') IS NOT NULL THEN
        RETURN NULL;
    END IF;

    IF NOT can_connect_to_server(server, hasura_session) THEN
        RETURN NULL;
    END IF;

    server_host := get_server_host(server);

    RETURN CONCAT('steam://run/', CASE WHEN server.game = 'csgo' THEN '4465480' ELSE '730' END, '//+connect ', server_host);
END;
$$;

-- The pod switches GOTV on in the config CS2 execs after the Valve mode's
-- own. A match runs it on Ranked, the practice plugin turns it off, a CS:GO
-- server never gets that config written, and Rush execs none.
CREATE OR REPLACE FUNCTION public.server_runs_tv(server public.servers) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    RETURN COALESCE(
        server.tv_enabled
        AND server.tv_port IS NOT NULL
        AND server.type NOT IN ('Ranked', 'Practice')
        AND server.game IS DISTINCT FROM 'csgo'
        AND NOT EXISTS (
            SELECT 1 FROM public.game_modes gm
             WHERE gm.id = server.game_mode_id
               AND gm.valve_mode = 'rush'
        ),
        false
    );
END;
$$;

-- GOTV goes to whoever may join, behind the same password: the pod sets
-- tv_password to the connect password. Like a match's, it is host:tv_port
-- even on a Steam relay region.
CREATE OR REPLACE FUNCTION public.get_server_tv_connection_string(server public.servers, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    connection_string text;
BEGIN
    IF NOT server_runs_tv(server) OR get_server_connection_string(server, hasura_session) IS NULL THEN
        RETURN NULL;
    END IF;

    connection_string := CONCAT('connect ', server.host, ':', server.tv_port);

    IF NULLIF(server.connect_password, '') IS NULL THEN
        RETURN connection_string;
    END IF;

    RETURN CONCAT(connection_string, '; password ', server.connect_password);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_server_tv_connection_link(server public.servers, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    IF NOT server_runs_tv(server) OR get_server_connection_link(server, hasura_session) IS NULL THEN
        RETURN NULL;
    END IF;

    RETURN CONCAT('steam://run/', CASE WHEN server.game = 'csgo' THEN '4465480' ELSE '730' END, '//+connect ', server.host, ':', server.tv_port);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_server_host(server public.servers) RETURNS text
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    server_host text;
BEGIN
    SELECT 
        CASE 
            WHEN sr.is_lan = FALSE AND s.steam_relay IS NOT NULL THEN s.steam_relay
            ELSE CONCAT(s.host, ':', s.port)
        END
    INTO server_host
    FROM servers s
    INNER JOIN server_regions sr ON sr.value = s.region
    WHERE s.id = server.id
    LIMIT 1;
    
    RETURN server_host;
END;
$$;
