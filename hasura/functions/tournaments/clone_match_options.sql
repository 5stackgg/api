CREATE OR REPLACE FUNCTION clone_match_options(
    _match_options_id uuid
)
RETURNS uuid AS $$
DECLARE
    _options match_options%ROWTYPE;
BEGIN
    IF _match_options_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT * INTO _options
    FROM match_options
    WHERE id = _match_options_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- Whole-row copy instead of an explicit column list. Every hand-maintained
    -- list of match_options columns has silently dropped settings as new ones
    -- were added (round_restart_delay, halftime_pausematch, auto_cancellation),
    -- producing tournaments whose matches quietly ignore their own settings.
    _options.id := gen_random_uuid();

    INSERT INTO match_options VALUES (_options.*);

    RETURN _options.id;
END;
$$ LANGUAGE plpgsql;
