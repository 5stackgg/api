
CREATE OR REPLACE FUNCTION public.update_tournament_stages(_tournament_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    stage RECORD;
    round int;
    max_round int;
    parents uuid[] := '{}';
    available_parents uuid[];
    matches_for_round int;
    max_matches int;
    created_matches int;
    parent_id uuid;
    new_id uuid;
    match_number int;
    tournament_status text;
    total_teams int;
BEGIN
    -- Get the tournament status
    SELECT status INTO tournament_status
    FROM tournaments
    WHERE id = _tournament_id;
    -- Get the total number of teams
    SELECT count(*) INTO total_teams
    FROM tournament_teams
    WHERE tournament_id = _tournament_id;
    -- Process each stage
    FOR stage IN
        SELECT *
        FROM tournament_stages
        WHERE tournament_id = _tournament_id
        ORDER BY "order"
    LOOP
        -- Delete existing brackets for this stage
        DELETE FROM tournament_brackets WHERE tournament_stage_id = stage.id;
        -- Calculate the maximum number of rounds and matches based on the status
        IF tournament_status = 'Setup' OR tournament_status = 'Scheduled'  THEN
            max_round := ceil(log(stage.max_teams) / log(2));
            max_matches := stage.max_teams - 1;
        ELSE
            max_round := ceil(log(total_teams) / log(2));
            max_matches := total_teams - 1;
        END IF;
        RAISE NOTICE 'totals: max_round=%, max_matches=%', max_round, max_matches;
        match_number := max_matches;
        -- Create the last match first
        INSERT INTO tournament_brackets (round, tournament_stage_id, match_number)
        VALUES (max_round, stage.id, match_number) RETURNING id INTO new_id;
        RAISE NOTICE 'match_number: match_number=%', match_number;
        parents := array_append(parents, new_id);
        -- Initialize for the next rounds
        round := max_round - 1;
        matches_for_round := 2;
        WHILE round > 0 AND matches_for_round * 2 <= COALESCE(stage.max_teams, total_teams) LOOP
            created_matches := 0;
            available_parents := parents;
            parents := '{}';
            RAISE NOTICE 'Processing round: round=%, matches=%, parents=%',
                round, matches_for_round, available_parents;
            WHILE created_matches < matches_for_round LOOP
                parent_id := available_parents[array_length(available_parents, 1)];
                available_parents := array_remove(available_parents, parent_id);
                match_number := match_number - 1;
                -- Create two matches for each parent
                INSERT INTO tournament_brackets (round, tournament_stage_id, parent_bracket_id, match_number)
                    VALUES (round, stage.id, parent_id, match_number) RETURNING id INTO new_id;
                parents := array_append(parents, new_id);
                INSERT INTO tournament_brackets (round, tournament_stage_id, parent_bracket_id, match_number)
                    VALUES (round, stage.id, parent_id, match_number - 1) RETURNING id INTO new_id;
                parents := array_append(parents, new_id);
                created_matches := created_matches + 2;
            END LOOP;
            round := round - 1;
            matches_for_round := matches_for_round * 2;
        END LOOP;
    END LOOP;
    RETURN;
END;
$$;