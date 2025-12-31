CREATE OR REPLACE FUNCTION update_match_options_best_of(
    _stage_id uuid
)
RETURNS uuid AS $$
DECLARE
    original_match_options_id uuid;
    match_options_record match_options%ROWTYPE;
    final_match_options_id uuid;
BEGIN
    -- Get match_options_id from stage first, then tournament if stage doesn't have one
    SELECT COALESCE(
        ts.match_options_id,
        t.match_options_id
    ) INTO original_match_options_id
    FROM tournament_stages ts
    INNER JOIN tournaments t ON t.id = ts.tournament_id
    WHERE ts.id = _stage_id;
    
    -- If no match_options_id found, return NULL
    IF original_match_options_id IS NULL THEN
        RETURN NULL;
    END IF;
    
    -- Get match_options record and check if best_of needs to be changed
    SELECT * INTO match_options_record
    FROM match_options
    WHERE id = original_match_options_id;
    
    -- If best_of is 1, create a new match_options with best_of = 3
    IF match_options_record.best_of = 1 THEN
        match_options_record.best_of := 3;
        -- Insert the modified record (id will be auto-generated)
        INSERT INTO match_options (
            overtime, knife_round, mr, best_of, coaches, number_of_substitutes,
            map_veto, timeout_setting, tech_timeout_setting, map_pool_id, type,
            regions, prefer_dedicated_server, invite_code, lobby_access,
            region_veto, ready_setting, check_in_setting, default_models, tv_delay
        ) VALUES (
            match_options_record.overtime, match_options_record.knife_round, 
            match_options_record.mr, match_options_record.best_of, 
            match_options_record.coaches, match_options_record.number_of_substitutes,
            match_options_record.map_veto, match_options_record.timeout_setting, 
            match_options_record.tech_timeout_setting, match_options_record.map_pool_id, 
            match_options_record.type, match_options_record.regions, 
            match_options_record.prefer_dedicated_server, match_options_record.invite_code, 
            match_options_record.lobby_access, match_options_record.region_veto, 
            match_options_record.ready_setting, match_options_record.check_in_setting, 
            match_options_record.default_models, match_options_record.tv_delay
        )
        RETURNING id INTO final_match_options_id;
    ELSE
        final_match_options_id := original_match_options_id;
    END IF;
    
    RETURN final_match_options_id;
END;
$$ LANGUAGE plpgsql;

