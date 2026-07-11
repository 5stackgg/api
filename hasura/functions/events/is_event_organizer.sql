CREATE OR REPLACE FUNCTION public.is_event_organizer(
    event public.events,
    hasura_session json
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT
        hasura_session ->> 'x-hasura-role' IN ('admin', 'administrator', 'tournament_organizer')
        -- nullif guard matches event_access.sql: an empty x-hasura-user-id
        -- must read as anonymous rather than fail the ::bigint cast.
        OR event.organizer_steam_id = nullif(hasura_session ->> 'x-hasura-user-id', '')::bigint
        OR EXISTS (
            SELECT 1
            FROM public.event_organizers
            WHERE event_id = event.id
              AND steam_id = nullif(hasura_session ->> 'x-hasura-user-id', '')::bigint
        );
$$;
