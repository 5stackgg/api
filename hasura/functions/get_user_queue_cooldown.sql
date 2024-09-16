CREATE OR REPLACE FUNCTION get_player_matchmaking_cooldown(player public.players, hasura_session json)
RETURNS TIMESTAMP WITH TIME ZONE AS $$
DECLARE
    abandoned_count INTEGER;
    last_abandoned_time TIMESTAMP WITH TIME ZONE;
    minutes_since_last_abandoned INTEGER;
    cooldown_duration INTEGER;
    cooldown_time TIMESTAMP WITH TIME ZONE;
    cooldown_durations INTEGER[] := ARRAY[10, 60, 120, 240, 480, 960, 1920];
BEGIN

    IF (hasura_session ->> 'x-hasura-user-id')::bigint != player.steam_id::bigint THEN
        RETURN NULL;
    END IF;

    SELECT COUNT(*) INTO abandoned_count
    FROM abandoned_matches
    WHERE steam_id = player.steam_id;

    IF abandoned_count > 0 THEN
        SELECT abandoned_at
        INTO last_abandoned_time
        FROM abandoned_matches
        WHERE steam_id = player.steam_id
        ORDER BY abandoned_at DESC
        LIMIT 1;

        cooldown_time := last_abandoned_time + (cooldown_durations[LEAST(abandoned_count, array_length(cooldown_durations, 1))] * INTERVAL '1 minute');

        IF cooldown_time > NOW() THEN
            RETURN cooldown_time;
        END IF; 
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql stable;