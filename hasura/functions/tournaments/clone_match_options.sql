CREATE OR REPLACE FUNCTION clone_match_options(
    _match_options_id uuid
)
RETURNS uuid AS $$
DECLARE
    cloned_id uuid;
BEGIN
    IF _match_options_id IS NULL THEN
        RETURN NULL;
    END IF;

    INSERT INTO match_options (
        overtime, knife_round, mr, best_of, coaches, number_of_substitutes,
        map_veto, timeout_setting, tech_timeout_setting, map_pool_id, type,
        regions, prefer_dedicated_server, invite_code, lobby_access,
        region_veto, ready_setting, check_in_setting, default_models, tv_delay,
        auto_cancellation, match_mode, auto_cancel_duration, live_match_timeout
    )
    SELECT
        overtime, knife_round, mr, best_of, coaches, number_of_substitutes,
        map_veto, timeout_setting, tech_timeout_setting, map_pool_id, type,
        regions, prefer_dedicated_server, invite_code, lobby_access,
        region_veto, ready_setting, check_in_setting, default_models, tv_delay,
        auto_cancellation, match_mode, auto_cancel_duration, live_match_timeout
    FROM match_options
    WHERE id = _match_options_id
    RETURNING id INTO cloned_id;

    RETURN cloned_id;
END;
$$ LANGUAGE plpgsql;
