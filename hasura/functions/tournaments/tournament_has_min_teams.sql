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

    -- Count actual eligible teams. eligible_at only tracks roster size, and
    -- assign_seeds_to_teams is what folds a missed check-in into it -- so before
    -- that has run a no-show still looks eligible here. Applying the same gate
    -- keeps the CancelledMinTeams safety net honest when a tournament proceeds
    -- out of CheckInReview. Constant true when check-in is off or has not opened.
    SELECT COUNT(tt.*)
        INTO total_teams
        FROM tournament_teams tt
        WHERE tt.tournament_id = tournament.id
        and tt.eligible_at is not null
        and (
            not (tournament.check_in_required and tournament_check_in_started(tournament))
            or tt.checked_in_at is not null
        );

    -- Log validation details
    RAISE NOTICE 'Tournament % (status: %): %/% teams (actual/required)', 
        tournament.id, tournament_status, total_teams, tournament_min_teams;

    -- Return validation result
    RETURN tournament_min_teams <= total_teams;
END;
$$;