CREATE OR REPLACE FUNCTION player_match_password(match matches, type text, hasura_session json) returns text
    language plpgsql
    as $$
DECLARE
    token text;
    password text;
    player_role text;
    player_steam_id bigint;
BEGIN
    player_role := hasura_session ->> 'x-hasura-role';
    player_steam_id := (hasura_session ->> 'x-hasura-user-id')::bigint;

    IF player_role = 'admin' THEN
        SELECT m.password INTO password
        FROM matches m
        WHERE m.id = match.id;
    ELSE
        IF type = 'game' THEN
            SELECT m.password INTO password
            FROM matches m
            INNER JOIN v_match_lineups ml ON ml.match_id = m.id
            INNER JOIN match_lineup_players mlp ON mlp.match_lineup_id = ml.id
            WHERE m.id = match.id AND mlp.steam_id = player_steam_id;
        ELSIF type = 'tv' THEN
            SELECT m.password INTO password
            FROM matches m
            -- INNER JOIN v_match_lineups ml ON ml.match_id = m.id
            -- INNER JOIN match_lineup_players mlp ON mlp.match_lineup_id = ml.id
            WHERE m.id = match.id;
            -- AND mlp.steam_id = player_steam_id;
        END IF;
    END IF;

    IF password IS NULL THEN
        RETURN NULL;
    END IF;

    token := encode(hmac(concat(type, ':', player_role, ':', player_steam_id, ':', match.id)::bytea, password::bytea, 'sha256'), 'base64');

    password := concat(type, ':', player_role, ':', token);

    -- URL safe characters
    password := replace(password, '+', '-');
    password := replace(password, '/', '_');

    RETURN password;
END;
$$;