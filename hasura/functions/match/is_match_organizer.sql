CREATE OR REPLACE FUNCTION public.is_match_organizer(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    user_role text;
    user_steam_id bigint;
BEGIN
    user_role := hasura_session ->> 'x-hasura-role';
    user_steam_id := (hasura_session ->> 'x-hasura-user-id')::bigint;

    -- Fast path: Admin roles always have permission
    IF user_role IN ('admin', 'administrator', 'tournament_organizer', 'match_organizer') THEN
        RETURN true;
    END IF;

    -- Fast path: Direct match organizer
    IF match.organizer_steam_id = user_steam_id THEN
        RETURN true;
    END IF;

    -- Combined tournament check and organizer lookup in single query
    -- This replaces the is_tournament_match() call + separate organizer query
    RETURN EXISTS (
        SELECT 1
        FROM tournament_brackets tb
        INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        INNER JOIN tournaments t ON t.id = ts.tournament_id
        INNER JOIN tournament_organizers _to ON _to.tournament_id = t.id
        WHERE tb.match_id = match.id
          AND _to.steam_id = user_steam_id
    );
END;
$$;
