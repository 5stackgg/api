CREATE OR REPLACE FUNCTION public.can_pause_tournament(
    tournament public.tournaments,
    hasura_session json
)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    IF tournament.status != 'Live' THEN
        RETURN false;
    END IF;

    RETURN is_tournament_organizer(tournament, hasura_session);
END;
$$;
