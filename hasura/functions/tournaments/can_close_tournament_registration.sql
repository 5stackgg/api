CREATE OR REPLACE FUNCTION public.can_close_tournament_registration(
    tournament public.tournaments,
    hasura_session json
)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    -- Also the "continue without them" exit from check-in review.
    IF tournament.status NOT IN ('RegistrationOpen', 'CheckInReview') THEN
        RETURN false;
    END IF;

    IF hasura_session ->> 'x-hasura-role' = 'admin' OR hasura_session ->> 'x-hasura-role' = 'administrator' OR hasura_session ->> 'x-hasura-role' = 'tournament_organizer' THEN
        RETURN true;
    END IF;

    RETURN tournament.organizer_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint;
END;
$$;
