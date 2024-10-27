CREATE OR REPLACE FUNCTION public.can_open_tournament_registration(
    tournament public.tournaments,
    hasura_session json
)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    has_stages boolean;
BEGIN
    IF tournament.status != 'Setup' AND tournament.status != 'RegistrationClosed' AND tournament.status != 'Cancelled' AND tournament.status != 'CancelledMinTeams' THEN
        RETURN false;
    END IF;

    IF tournament.start < now() THEN
        RETURN false;
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM tournament_stages ts
        WHERE ts.tournament_id = tournament.id
    ) INTO has_stages;

    IF NOT has_stages THEN
        RETURN false;
    END IF;
    
    IF hasura_session ->> 'x-hasura-role' = 'admin' THEN
        RETURN true;
    END IF;

    IF hasura_session ->> 'x-hasura-role' = 'administrator' THEN
        RETURN true;
    END IF;

    IF hasura_session ->> 'x-hasura-role' = 'tournament_organizer' THEN
        RETURN true;
    END IF;

    RETURN tournament.organizer_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint;
END;
$$;
