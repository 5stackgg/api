CREATE OR REPLACE FUNCTION clone_match_options_with_best_of(
    _match_options_id uuid,
    _target_best_of int
)
RETURNS uuid AS $$
DECLARE
    cloned_id uuid;
BEGIN
    IF _match_options_id IS NULL THEN
        RETURN NULL;
    END IF;

    cloned_id := clone_match_options(_match_options_id);

    IF cloned_id IS NULL THEN
        RETURN NULL;
    END IF;

    IF _target_best_of IS NOT NULL THEN
        UPDATE match_options
        SET best_of = _target_best_of
        WHERE id = cloned_id
          AND best_of IS DISTINCT FROM _target_best_of;
    END IF;

    RETURN cloned_id;
END;
$$ LANGUAGE plpgsql;
