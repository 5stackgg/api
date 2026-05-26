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

    -- Only Setup/RegistrationOpen plan the bracket against max_teams; in every
    -- other status (RegistrationClosed, Live, Paused, Finished, Cancelled*)
    -- the eligible-team count is final, so size the bracket to that instead
    -- of padding unfilled slots with byes.
    IF _tournament_status IN ('Setup', 'RegistrationOpen') THEN
        effective_teams := stage_max_teams;
    ELSE
        IF _stage_order = 1 THEN
            SELECT COUNT(*) INTO effective_teams
                FROM tournament_teams
                WHERE tournament_id = _tournament_id AND eligible_at IS NOT NULL;

            -- Downstream bracket math in update_tournament_stages takes
            -- LOG(teams_per_group), which raises on 0 and produces an empty
            -- bracket on 1. Before the tournament is Live/Finished the count
            -- is not yet final, so fall back to max_teams when it can't form
            -- a valid bracket — admins can still edit stages, and the
            -- placeholder bracket renders. In Live/Finished we accept the
            -- real count: those statuses are gated by tournament_has_min_teams.
            IF effective_teams < 2 AND _tournament_status NOT IN ('Live', 'Finished') THEN
                effective_teams := stage_max_teams;
            END IF;
        ELSE
            -- Get the previous stage to check its type
            DECLARE
                previous_stage_type text;
                previous_stage_max_teams int;
            BEGIN
                SELECT type, max_teams INTO previous_stage_type, previous_stage_max_teams
                FROM tournament_stages
                WHERE tournament_id = _tournament_id AND "order" = _stage_order - 1;

                -- For RoundRobin stages, only the top teams advance, capped by this
                -- stage's max_teams. Using the previous stage's max_teams here would
                -- size brackets for every team in the RR, not just the qualifiers.
                IF previous_stage_type = 'RoundRobin' THEN
                    effective_teams := LEAST(stage_max_teams, previous_stage_max_teams);
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