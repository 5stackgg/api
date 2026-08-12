CREATE OR REPLACE FUNCTION update_match_options_best_of(
    _stage_id uuid
)
RETURNS uuid AS $$
DECLARE
    original_match_options_id uuid;
    _decider_best_of int;
    _current_best_of int;
BEGIN
    -- Get match_options_id from stage first, then tournament if stage doesn't have one
    SELECT COALESCE(ts.match_options_id, t.match_options_id), ts.decider_best_of
    INTO original_match_options_id, _decider_best_of
    FROM tournament_stages ts
    INNER JOIN tournaments t ON t.id = ts.tournament_id
    WHERE ts.id = _stage_id;

    IF original_match_options_id IS NULL THEN
        RETURN NULL;
    END IF;

    -- Only apply a different BO if the stage explicitly has decider_best_of set
    IF _decider_best_of IS NULL THEN
        RETURN original_match_options_id;
    END IF;

    SELECT best_of INTO _current_best_of
    FROM match_options
    WHERE id = original_match_options_id;

    -- If target BO equals current BO, no clone needed
    IF _decider_best_of = _current_best_of THEN
        RETURN original_match_options_id;
    END IF;

    RETURN clone_match_options_with_best_of(
        original_match_options_id,
        _decider_best_of
    );
END;
$$ LANGUAGE plpgsql;
