CREATE OR REPLACE FUNCTION public.can_resume_tournament(
    tournament public.tournaments,
    hasura_session json
)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    IF tournament.status != 'Paused' THEN
        RETURN false;
    END IF;

    IF hasura_session ->> 'x-hasura-role' = 'admin' OR hasura_session ->> 'x-hasura-role' = 'administrator' OR hasura_session ->> 'x-hasura-role' = 'tournament_organizer' THEN
        RETURN true;
    END IF;

    RETURN is_tournament_organizer(tournament, hasura_session);
END;
$$;
