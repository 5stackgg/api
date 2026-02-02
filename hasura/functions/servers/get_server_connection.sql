CREATE OR REPLACE FUNCTION public.get_server_connection_string(server public.servers, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    connection_string text;
    min_role_to_connect text;
BEGIN
    IF server.connected = false OR server.enabled = false OR server.type = 'Ranked' OR server.host IS NULL OR server.port IS NULL THEN
        RETURN NULL;
    END IF;

    connection_string := CONCAT('connect ', get_server_host(server));

    IF server.connect_password IS NULL THEN
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
    IF server.connected = false OR server.enabled = false OR server.type = 'Ranked' OR NULLIF(server.connect_password, '') IS NOT NULL THEN
        RETURN NULL;
    END IF;

    server_host := get_server_host(server);

    RETURN CONCAT('steam://run/730//+connect ', server_host);
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
