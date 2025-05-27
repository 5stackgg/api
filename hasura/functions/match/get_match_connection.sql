CREATE OR REPLACE FUNCTION public.get_match_connection_string(match public.matches, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    password text;
    server_info record;
    connection_string text;
BEGIN
    SELECT * INTO server_info FROM get_match_server_info(match);

    IF(server_info.server_host IS NULL) THEN
        return NULL;
    END IF;
    
    connection_string := CONCAT('connect ', server_info.host);

    if(is_in_lineup(match, hasura_session)) then
        return connection_string;
    end if;

    password := player_match_password(match, 'game', hasura_session);

    if(password is null) then
        return null;
    end if;

    return CONCAT(connection_string, '; password ', password);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_match_connection_link(match public.matches, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    server_info record;
BEGIN
    SELECT * INTO server_info FROM get_match_server_info(match);

    IF(server_info.server_host IS NULL OR is_in_lineup(match, hasura_session) = FALSE) THEN
        return NULL;
    END IF;

    RETURN CONCAT('steam://run/730//+connect ', server_info.host);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_match_server_info(match public.matches) RETURNS TABLE (
    server_host text,
    server_port int,
    steam_relay text,
    is_lan boolean,
    host text
) LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        s.host,
        s.port,
        s.steam_relay,
        sr.is_lan,
        CASE 
            WHEN sr.is_lan = FALSE AND s.steam_relay IS NOT NULL THEN s.steam_relay
            ELSE CONCAT(s.host, ':', s.port)
        END as host
    FROM matches m
    INNER JOIN servers s ON s.id = m.server_id
    INNER JOIN server_regions sr ON sr.value = s.region
    WHERE m.id = match.id
    LIMIT 1;
END;
$$;
