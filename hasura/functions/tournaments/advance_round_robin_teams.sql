CREATE OR REPLACE FUNCTION public.advance_round_robin_teams(_stage_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    current_stage RECORD;
    next_stage_id uuid;
BEGIN
    SELECT ts.tournament_id, ts."order", ts.groups, ts.max_teams
    INTO current_stage
    FROM tournament_stages ts
    WHERE ts.id = _stage_id;
    
    IF current_stage IS NULL THEN
        RAISE EXCEPTION 'Stage % not found', _stage_id USING ERRCODE = '22000';
    END IF;
    
    SELECT ts.id, ts.max_teams
    INTO next_stage_id
    FROM tournament_stages ts
    WHERE ts.tournament_id = current_stage.tournament_id
      AND ts."order" = current_stage."order" + 1;
    
    IF next_stage_id IS NULL THEN
        RETURN;
    END IF;

    PERFORM seed_stage(next_stage_id);
END;
$$;
