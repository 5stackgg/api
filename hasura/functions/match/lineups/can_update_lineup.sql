CREATE OR REPLACE FUNCTION public.can_update_lineup(match_lineup public.match_lineups, hasura_session json) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    match public.matches;
BEGIN
     SELECT m.* INTO match
        FROM matches m
        INNER JOIN v_match_lineups ml ON ml.match_id = m.id
        WHERE ml.id = match_lineup.id;

        IF match.status != 'PickingPlayers' AND match.status != 'Scheduled' THEN
            return false;
        END IF;

     IF match_lineup.coach_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint THEN
        return true;
     END IF;

    IF is_match_organizer(match, hasura_session) THEN
        RETURN true;
    END IF;

    return false;
END;
$$;
