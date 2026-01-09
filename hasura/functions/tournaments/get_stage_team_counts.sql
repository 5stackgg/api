CREATE OR REPLACE FUNCTION get_stage_team_counts(
    _tournament_id uuid,
    _stage_order int,
    _tournament_status text
) RETURNS TABLE(stage_max_teams int, effective_teams int) AS $$
BEGIN
    -- Get stage max_teams
    SELECT max_teams INTO stage_max_teams
    FROM tournament_stages
    WHERE tournament_id = _tournament_id AND "order" = _stage_order;

    -- If tournament is in Setup status, use max_teams for bracket planning
    IF _tournament_status != 'Live' AND _tournament_status != 'Finished' THEN
        effective_teams := stage_max_teams;
    ELSE
        IF _stage_order = 1 THEN
            SELECT COUNT(*) INTO effective_teams
                FROM tournament_teams
                WHERE tournament_id = _tournament_id AND eligible_at IS NOT NULL;
        ELSE
            -- Get the previous stage to check its type
            DECLARE
                previous_stage_type text;
                previous_stage_max_teams int;
            BEGIN
                SELECT type, max_teams INTO previous_stage_type, previous_stage_max_teams
                FROM tournament_stages
                WHERE tournament_id = _tournament_id AND "order" = _stage_order - 1;
                
                -- For RoundRobin stages, use max_teams (all teams can advance)
                -- For elimination stages, count matches in last round (each match = 1 advancing team)
                IF previous_stage_type = 'RoundRobin' THEN
                    effective_teams := previous_stage_max_teams;
                ELSE
                    -- get the number of matches from the last round of the previous stage
                    SELECT COUNT(*) INTO effective_teams
                    FROM tournament_brackets tb
                    JOIN tournament_stages ts ON tb.tournament_stage_id = ts.id
                    WHERE ts.tournament_id = _tournament_id 
                      AND ts."order" = _stage_order - 1 
                      AND tb.round = (
                          SELECT MAX(tb2.round) 
                          FROM tournament_brackets tb2 
                          JOIN tournament_stages ts2 ON tb2.tournament_stage_id = ts2.id 
                          WHERE ts2.tournament_id = _tournament_id 
                            AND ts2."order" = _stage_order - 1
                      );
                END IF;
            END;
        END IF;
    END IF;

    RETURN NEXT;
END;
$$ LANGUAGE plpgsql;