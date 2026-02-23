CREATE OR REPLACE FUNCTION get_bracket_best_of(
    _stage_id uuid,
    _path text,
    _round int
)
RETURNS int AS $$
DECLARE
    _stage tournament_stages;
    _round_key text;
    _round_best_of int;
BEGIN
    SELECT * INTO _stage
    FROM tournament_stages
    WHERE id = _stage_id;

    IF NOT FOUND THEN
        RETURN 1;
    END IF;

    -- Build the lookup key based on stage type
    IF _stage.type = 'Swiss' THEN
        -- For Swiss, the "round" is encoded as wins*100+losses in the group field
        -- But when called from schedule_tournament_match, we pass the bracket's group as round
        -- The caller should pass the appropriate key: "regular", "advancement", or "elimination"
        -- This function receives path as the swiss match type key
        _round_key := _path;
    ELSE
        -- For SE/DE: key is "path:round" e.g. "WB:1", "LB:3", "GF"
        IF _path = 'WB' AND _stage.type = 'DoubleElimination' THEN
            -- Check if this is the Grand Final round (WB round > ceil(log2(teams)))
            DECLARE
                _wb_rounds int;
                _teams_per_group int;
            BEGIN
                SELECT CEIL(LOG(CEIL(ts.max_teams::float / ts.groups)::numeric) / LOG(2))::int
                INTO _wb_rounds
                FROM tournament_stages ts
                WHERE ts.id = _stage_id;

                IF _round > _wb_rounds THEN
                    _round_key := 'GF';
                ELSE
                    _round_key := _path || ':' || _round::text;
                END IF;
            END;
        ELSE
            _round_key := _path || ':' || _round::text;
        END IF;
    END IF;

    -- Look up in settings JSONB
    IF _stage.settings IS NOT NULL AND _stage.settings ? 'round_best_of' THEN
        _round_best_of := (_stage.settings->'round_best_of'->>_round_key)::int;
        IF _round_best_of IS NOT NULL THEN
            RETURN _round_best_of;
        END IF;
    END IF;

    -- Fall back to default_best_of
    RETURN _stage.default_best_of;
END;
$$ LANGUAGE plpgsql;
