CREATE OR REPLACE FUNCTION public.is_match_organizer(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    organizer_exists boolean;
BEGIN
    IF hasura_session ->> 'x-hasura-role' = 'admin' OR hasura_session ->> 'x-hasura-role' = 'administrator' THEN
        RETURN true;
    END IF;

    IF is_tournament_match(match) THEN
        IF hasura_session ->> 'x-hasura-role' = 'tournament_organizer' THEN
            return true;
        END IF;

        SELECT EXISTS (
            SELECT 1
            FROM matches m
            INNER JOIN tournament_brackets tb ON tb.match_id = m.id
            INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
            INNER JOIN tournaments t ON t.id = ts.tournament_id
            INNER JOIN tournament_organizers _to ON _to.tournament_id = t.id
            WHERE _to.steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
              AND m.id = match.id
        ) INTO organizer_exists;

        IF organizer_exists THEN
            return true;
        END IF;

        return false;
    END IF;

    IF hasura_session ->> 'x-hasura-role' = 'match_organizer' THEN
        return true;
    END IF;

	IF match.organizer_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint THEN
		return true;
	END IF;

	return false;
END;
$$;
