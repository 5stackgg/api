CREATE OR REPLACE FUNCTION public.advance_swiss_teams_to_next_stage(_stage_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    current_stage RECORD;
    next_stage_id uuid;
BEGIN
    -- Get current stage information
    SELECT ts.tournament_id, ts."order", ts.groups, ts.max_teams
    INTO current_stage
    FROM tournament_stages ts
    WHERE ts.id = _stage_id;
    
    IF current_stage IS NULL THEN
        RAISE EXCEPTION 'Stage % not found', _stage_id;
    END IF;
    
    -- Find next stage
    SELECT ts.id, ts.max_teams
    INTO next_stage_id
    FROM tournament_stages ts
    WHERE ts.tournament_id = current_stage.tournament_id
      AND ts."order" = current_stage."order" + 1;
    
    IF next_stage_id IS NULL THEN
        RAISE NOTICE 'No next stage found for Swiss stage %', _stage_id;
        RETURN;
    END IF;

    RAISE NOTICE 'Advancing teams from Swiss stage % to next stage %', _stage_id, next_stage_id;
    
    -- Seed the next stage (teams with 3+ wins will be selected from v_team_stage_results)
    -- This works similarly to RoundRobin - teams are ordered by their results in v_team_stage_results
    PERFORM seed_stage(next_stage_id);
END;
$$;

