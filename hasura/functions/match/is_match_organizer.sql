CREATE OR REPLACE FUNCTION public.is_match_organizer(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT
        hasura_session ->> 'x-hasura-role' IN ('admin', 'administrator', 'tournament_organizer', 'match_organizer')
        OR match.organizer_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
        OR EXISTS (
            SELECT 1
            FROM tournament_brackets tb
            INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
            INNER JOIN tournament_organizers _to ON _to.tournament_id = ts.tournament_id
            WHERE tb.match_id = match.id
              AND _to.steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
        );
$$;
