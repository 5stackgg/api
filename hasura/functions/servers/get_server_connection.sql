CREATE OR REPLACE FUNCTION public.get_server_connection_string(server public.servers, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    connection_string text;
    server_host text;
    min_role_to_connect text;
BEGIN
    IF server.enabled = false OR server.type = 'Ranked' OR server.host IS NULL OR server.port IS NULL THEN
        RETURN NULL;
    END IF;

    IF server.steam_relay IS NOT NULL THEN
        server_host := server.steam_relay;
    ELSE
        server_host := CONCAT(server.host, ':', server.port);
    END IF;

    connection_string := CONCAT('connect ', server_host);

    IF server.connect_password IS NULL THEN
        RETURN connection_string;
    END IF;

    min_role_to_connect := get_setting('dedicated_servers_min_role_to_connect', 'user');
    
    IF is_above_role(min_role_to_connect, hasura_session) THEN
        RETURN CONCAT(connection_string, '; password ', server.connect_password);
    END IF; 

    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_server_connection_link(server public.servers, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    server_host text;
BEGIN
    IF server.enabled = false OR server.type = 'Ranked' OR server.host IS NULL OR server.port IS NULL OR server.connect_password IS NOT NULL THEN
        RETURN NULL;
    END IF;

    IF server.steam_relay IS NOT NULL THEN
        server_host := server.steam_relay;
    ELSE
        server_host := CONCAT(server.host, ':', server.port);
    END IF;

    RETURN CONCAT('steam://run/730//+connect ', server_host);
END;
$$;
