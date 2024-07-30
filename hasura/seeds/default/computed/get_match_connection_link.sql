CREATE FUNCTION public.get_match_connection_link(match public.matches, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    password text;
    connection_string text;
    server_host text;
    server_port int;
BEGIN
    SELECT
	 m.password INTO password
    FROM matches m
    INNER JOIN v_match_lineups ml on ml.match_id = m.id
    INNER JOIN match_lineup_players mlp on mlp.match_lineup_id = ml.id
    WHERE m.id = match.id AND mlp.steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint;
	 IF password IS NULL THEN
        RETURN NULL;
    END IF;
    SELECT s.host, s.port
    INTO server_host, server_port
    FROM matches m
    INNER JOIN servers s ON s.id = m.server_id
    WHERE m.id = match.id
    LIMIT 1;
    connection_string := CONCAT('steam://connect/', server_host, ':', server_port, ';password/', password);
    RETURN CONCAT('/quick-connect?link=', connection_string);
END;
$$;