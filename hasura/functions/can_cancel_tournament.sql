CREATE OR REPLACE FUNCTION public.can_cancel_tournament(
    tournament public.tournaments,
    hasura_session json
)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    IF tournament.status = 'Cancelled' OR tournament.status = 'CancelledMinTeams' OR tournament.status = 'Finished' THEN
        return false;
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

    RETURN tournament.organizer_id = hasura_session ->> 'x-hasura-user-id';
END;
$$;
