
CREATE FUNCTION public.get_match_tv_connection_link(match public.matches, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    password text;
    connection_string text;
    server_host text;
	tv_port int;
BEGIN
    SELECT s.host, s.tv_port
    INTO server_host, tv_port
    FROM matches m
    INNER JOIN servers s ON s.id = m.server_id
    WHERE m.id = match.id
    LIMIT 1;
    connection_string := CONCAT('steam://connect/', server_host, ':', tv_port);
    RETURN CONCAT('/quick-connect?link=', connection_string);
END;
$$;