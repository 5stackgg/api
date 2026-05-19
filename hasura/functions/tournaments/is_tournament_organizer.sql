CREATE OR REPLACE FUNCTION public.is_tournament_organizer(
    tournament public.tournaments,
    hasura_session json
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT
        hasura_session ->> 'x-hasura-role' IN ('admin', 'administrator', 'tournament_organizer')
        OR tournament.organizer_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
        OR EXISTS (
            SELECT 1
            FROM public.tournament_organizers
            WHERE tournament_id = tournament.id
              AND steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
        );
$$;
