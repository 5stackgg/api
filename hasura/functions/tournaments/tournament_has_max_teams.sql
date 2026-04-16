CREATE OR REPLACE FUNCTION public.tournament_has_max_teams(tournament public.tournaments)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    total_teams int := 0;
    tournament_max_teams int := 0;
BEGIN
    SELECT SUM(ts.max_teams) INTO tournament_max_teams
        FROM tournament_stages ts
        WHERE ts.tournament_id = tournament.id
        AND ts."order" = 1;

    IF tournament_max_teams IS NULL OR tournament_max_teams = 0 THEN
        RETURN false;
    END IF;

    SELECT COUNT(tt.*)
        INTO total_teams
        FROM tournament_teams tt
        WHERE tt.tournament_id = tournament.id
        AND tt.eligible_at IS NOT NULL;

    RETURN total_teams >= tournament_max_teams;
END;
$$;
