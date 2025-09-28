CREATE OR REPLACE FUNCTION public.get_match_connection_string(match public.matches, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    password text;
    server_host text;
    connection_string text;
BEGIN
    server_host := get_match_server_info(match);

    IF(server_host IS NULL) THEN
        return NULL;
    END IF;
    
    connection_string := CONCAT('connect ', server_host);

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
    server_host text;
BEGIN
    server_host := get_match_server_info(match);

    IF(server_host IS NULL OR is_in_lineup(match, hasura_session) = FALSE) THEN
        return NULL;
    END IF;

    RETURN CONCAT('steam://run/730//+connect ', server_host);
END;
$$;

DROP FUNCTION IF EXISTS public.get_match_server_info(match public.matches);

CREATE OR REPLACE FUNCTION public.get_match_server_info(match public.matches) RETURNS text
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
    FROM matches m
    INNER JOIN servers s ON s.id = m.server_id
    INNER JOIN server_regions sr ON sr.value = s.region
    WHERE m.id = match.id
    LIMIT 1;
    
    RETURN server_host;
END;
$$;
