CREATE OR REPLACE FUNCTION player_match_password(match matches, type text, hasura_session json) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    token text;
    password text;
    player_role text;
    player_steam_id bigint;
    can_connect boolean;
    is_in_lineup boolean;
    minimum_role_to_stream text;
BEGIN
    IF match.password IS NULL THEN
        RETURN NULL;
    END IF;

    player_role := hasura_session ->> 'x-hasura-role';
    player_steam_id := (hasura_session ->> 'x-hasura-user-id')::bigint;
    can_connect := FALSE;
    is_in_lineup := is_in_lineup(match, hasura_session);

    IF player_role = 'admin' OR player_role = 'administrator' THEN
        can_connect := TRUE;
    ELSEIF type = 'game' THEN
        IF is_in_lineup THEN
            can_connect := TRUE;
        END IF;

        IF player_role = 'match_organizer' OR player_role = 'tournament_organizer' THEN
            IF is_tournament_match(match) THEN
                IF is_above_role(COALESCE(minimum_role_to_stream, 'tournament_organizer'), hasura_session) THEN
                    can_connect := TRUE;
                END IF;
            ELSE
                IF is_above_role(COALESCE(minimum_role_to_stream, 'match_organizer'), hasura_session) THEN
                    can_connect := TRUE;
                END IF; 
            END IF;
        END IF;
    ELSIF type = 'tv' THEN
        IF is_in_lineup THEN
            can_connect := FALSE;
        ELSE
            SELECT value INTO minimum_role_to_stream 
            FROM settings 
            WHERE name = 'public.minimum_role_to_stream';

            IF is_above_role(COALESCE(minimum_role_to_stream, 'user'), hasura_session) THEN
                can_connect := TRUE;
            END IF;
        END IF;
    END IF;

    IF can_connect = FALSE THEN
        RETURN NULL;
    END IF;

    password := match.password;
    token := encode(
        hmac(
            concat(type, ':', player_role, ':', player_steam_id, ':', match.id)::bytea, 
            password::bytea, 
            'sha256'
        ), 
        'base64'
    );
    
    password := concat(type, ':', player_role, ':', token);

    -- URL safe characters
    password := replace(password, '+', '-');
    password := replace(password, '/', '_');

    RETURN password;
END;
$$;