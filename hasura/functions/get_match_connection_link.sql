CREATE OR REPLACE FUNCTION public.get_match_connection_link(match public.matches, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    password text;
    connection_string text;
    server_host text;
    server_port int;
BEGIN
    IF hasura_session ->> 'x-hasura-role' = 'admin' THEN
        SELECT m.password INTO password
        FROM matches m
        WHERE m.id = match.id;
    ELSE
        SELECT m.password INTO password
            FROM matches m
            INNER JOIN v_match_lineups ml ON ml.match_id = m.id
            INNER JOIN match_lineup_players mlp ON mlp.match_lineup_id = ml.id
            WHERE m.id = match.id AND mlp.steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint;
    END IF;

	 IF password IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT s.host, s.port
        INTO server_host, server_port
        FROM matches m
        INNER JOIN servers s ON s.id = m.server_id
        WHERE m.id = match.id
        LIMIT 1;

    IF(server_host IS NULL) THEN
        return NULL;
    END IF;

    connection_string := CONCAT('steam://connect/', server_host, ':', server_port, ';password/', password);

    RETURN CONCAT('/quick-connect?link=', connection_string);
END;
$$;