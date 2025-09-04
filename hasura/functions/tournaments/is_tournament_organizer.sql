CREATE OR REPLACE FUNCTION public.is_tournament_organizer(
    tournament public.tournaments,
    hasura_session json
) RETURNS boolean
    LANGUAGE plpgsql STABLE
AS $$
DECLARE
BEGIN
    IF hasura_session ->> 'x-hasura-role' = 'admin' OR hasura_session ->> 'x-hasura-role' = 'administrator' THEN
        RETURN true;
    END IF;

    IF hasura_session ->> 'x-hasura-role' = 'tournament_organizer' THEN
        RETURN true;
    END IF;

    RETURN tournament.organizer_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint OR EXISTS (
        SELECT 1
        FROM public.tournament_organizers
        WHERE tournament_id = tournament.id
        AND steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
    );
END;
$$;
