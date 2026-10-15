-- Who may change who organizes a tournament: its owner, its co-organizers and
-- administrators. Not is_tournament_organizer, which passes every site-wide
-- tournament organizer for every tournament, and so would let one make
-- themselves a co-organizer of any of them.
CREATE OR REPLACE FUNCTION public.can_manage_tournament_organizers(
    tournament public.tournaments,
    hasura_session json
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(
        hasura_session ->> 'x-hasura-role' IN ('admin', 'administrator')
        OR tournament.organizer_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
        OR EXISTS (
            SELECT 1
            FROM public.tournament_organizers o
            WHERE o.tournament_id = tournament.id
              AND o.steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
        ),
        false
    );
$$;
