CREATE OR REPLACE FUNCTION public.tournament_has_min_teams(tournament public.tournaments)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    total_teams int := 0;
    tournament_min_teams int := 0;
    tournament_status text;
BEGIN
    -- Get tournament status for context
    SELECT status INTO tournament_status
    FROM tournaments
    WHERE id = tournament.id;
    
    -- Get minimum teams required for stage 1
    SELECT 
        SUM(ts.min_teams) into tournament_min_teams
        FROM tournament_stages ts
        WHERE ts.tournament_id = tournament.id
        AND ts.order = 1;

    -- Count actual eligible teams
    SELECT COUNT(tt.*)
        INTO total_teams
        FROM tournament_teams tt
        WHERE tt.tournament_id = tournament.id
        and tt.eligible_at is not null;

    -- Log validation details
    RAISE NOTICE 'Tournament % (status: %): %/% teams (actual/required)', 
        tournament.id, tournament_status, total_teams, tournament_min_teams;

    -- Return validation result
    RETURN tournament_min_teams <= total_teams;
END;
$$;