CREATE OR REPLACE FUNCTION public.can_setup_tournament(
    tournament public.tournaments,
    hasura_session json
)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    IF tournament.status != 'Cancelled' AND tournament.status != 'CancelledMinTeams' THEN
        RETURN false;
    END IF;

    IF hasura_session ->> 'x-hasura-role' = 'admin' OR
       hasura_session ->> 'x-hasura-role' = 'administrator' OR
       hasura_session ->> 'x-hasura-role' = 'tournament_organizer' THEN
        RETURN true;
    END IF;

    RETURN tournament.organizer_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint;
END;
$$;
