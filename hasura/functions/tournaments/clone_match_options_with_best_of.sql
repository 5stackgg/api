CREATE OR REPLACE FUNCTION clone_match_options_with_best_of(
    _match_options_id uuid,
    _target_best_of int
)
RETURNS uuid AS $$
DECLARE
    match_options_record match_options%ROWTYPE;
    cloned_id uuid;
BEGIN
    IF _match_options_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT * INTO match_options_record
    FROM match_options
    WHERE id = _match_options_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- If target best_of matches, no clone needed
    IF _target_best_of = match_options_record.best_of THEN
        RETURN _match_options_id;
    END IF;

    -- Clone with new best_of
    INSERT INTO match_options (
        overtime, knife_round, mr, best_of, coaches, number_of_substitutes,
        map_veto, timeout_setting, tech_timeout_setting, map_pool_id, type,
        regions, prefer_dedicated_server, invite_code, lobby_access,
        region_veto, ready_setting, check_in_setting, default_models, tv_delay,
        auto_cancel
    ) VALUES (
        match_options_record.overtime, match_options_record.knife_round,
        match_options_record.mr, _target_best_of,
        match_options_record.coaches, match_options_record.number_of_substitutes,
        match_options_record.map_veto, match_options_record.timeout_setting,
        match_options_record.tech_timeout_setting, match_options_record.map_pool_id,
        match_options_record.type, match_options_record.regions,
        match_options_record.prefer_dedicated_server, match_options_record.invite_code,
        match_options_record.lobby_access, match_options_record.region_veto,
        match_options_record.ready_setting, match_options_record.check_in_setting,
        match_options_record.default_models, match_options_record.tv_delay,
        match_options_record.auto_cancel
    )
    RETURNING id INTO cloned_id;

    RETURN cloned_id;
END;
$$ LANGUAGE plpgsql;
