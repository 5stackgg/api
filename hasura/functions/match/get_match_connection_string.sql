CREATE OR REPLACE FUNCTION public.get_match_connection_string(match public.matches, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    password text;
    server_host text;
    server_port int;
    steam_relay text;
    connection_string text;
BEGIN
    SELECT s.host, s.port, s.steam_relay
        INTO server_host, server_port, steam_relay
        FROM matches m
        INNER JOIN servers s ON s.id = m.server_id
        WHERE m.id = match.id
        LIMIT 1;

    IF(server_host IS NULL) THEN
        return NULL;
    END IF;

    connection_string := CONCAT('connect ', COALESCE(CONCAT(steam_relay, ':0'), CONCAT(server_host, ':', server_port)));
    if(is_in_lineup(match, hasura_session)) then
        return connection_string;
    end if;

    password := player_match_password(match, 'game', hasura_session);

    if(password is null) then
        return null;
    end if;

    return CONCAT(connection_string, ' +password "', password, '"');
END;
$$;
