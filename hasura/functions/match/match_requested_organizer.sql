CREATE OR REPLACE FUNCTION public.match_requested_organizer(match public.matches, hasura_session json)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT (is_match_organizer(match, hasura_session) OR is_in_lineup(match, hasura_session))
        AND EXISTS (
            SELECT 1 FROM notifications
            WHERE entity_id = match.id::text
              AND type = 'MatchSupport'
              AND is_read = false
        );
$$;
