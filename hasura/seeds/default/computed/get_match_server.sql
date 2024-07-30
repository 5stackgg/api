CREATE OR REPLACE FUNCTION public.get_match_server(match public.matches, hasura_session json) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    password text;
BEGIN
    SELECT m.password into password
    FROM matches m
    	INNER JOIN v_match_lineups ml on ml.match_id = m.id
    	INNER JOIN match_lineup_players mlp on mlp.match_lineup_id = ml.id
		INNER JOIN server s on s.id = m.server_id
    WHERE
    	m.id = match.id
    	AND mlp.steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint;
	return password;
END;
$$;