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
    -- CheckInReview is the "give them another chance" path: reopening extends
    -- the check-in window for the field that is already registered.
    IF tournament.status NOT IN ('Setup', 'RegistrationClosed', 'Cancelled', 'CancelledMinTeams', 'CheckInReview') THEN
        RETURN false;
    END IF;

    IF tournament.start < now() THEN
        RETURN false;
    END IF;

    -- A full bracket blocks a NEW intake, not an extension of the window for
    -- teams that are already in it.
    IF tournament.status != 'CheckInReview' AND tournament_has_max_teams(tournament) THEN
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
    
    IF hasura_session ->> 'x-hasura-role' = 'admin' OR hasura_session ->> 'x-hasura-role' = 'administrator' OR hasura_session ->> 'x-hasura-role' = 'tournament_organizer' THEN
        RETURN true;
    END IF;
    
    RETURN tournament.organizer_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint;
END;
$$;
