CREATE OR REPLACE FUNCTION public.get_match_connection_link(match public.matches, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    password text;
    server_host text;
    server_port int;
    steam_relay text;
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

    if(is_in_lineup(match, hasura_session) = FALSE) then
        return NULL;
    end if;

    RETURN CONCAT('steam://run/730//+connect ', COALESCE(CONCAT(steam_relay, ':0'), CONCAT(server_host, ':', server_port)));
END;
$$;