CREATE OR REPLACE FUNCTION public.get_match_connection_string(match public.matches, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    password text;
    server_host text;
    server_port int;
BEGIN
    SELECT s.host, s.port
        INTO server_host, server_port
        FROM matches m
        INNER JOIN servers s ON s.id = m.server_id
        WHERE m.id = match.id
        LIMIT 1;

    IF(server_host IS NULL) THEN
        return NULL;
    END IF;

    password := player_match_password(match, 'game', hasura_session);

    if(password is null) then
        return null;
    end if;

    return CONCAT('connect ', server_host, ':', server_port, ';password ', password);
END;
$$;
