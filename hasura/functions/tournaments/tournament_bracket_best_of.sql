-- NULL for a bracket with options of its own: its match keeps their best_of.
CREATE OR REPLACE FUNCTION public.tournament_bracket_best_of(_bracket public.tournament_brackets)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
    _stage tournament_stages;
    _wins int;
    _losses int;
    _wins_needed int := 3;
    _swiss_match_type text;
BEGIN
    IF _bracket.match_options_id IS NOT NULL THEN
        RETURN NULL;
    END IF;

    SELECT * INTO _stage
    FROM tournament_stages
    WHERE id = _bracket.tournament_stage_id;

    IF _stage.type != 'Swiss' THEN
        RETURN get_bracket_best_of(_stage.id, _bracket.path, _bracket.round);
    END IF;

    -- A Swiss group is wins*100+losses; a no-elimination stage plays only regular games.
    _wins := (_bracket."group" / 100)::int;
    _losses := (_bracket."group" % 100)::int;

    IF COALESCE(_stage.swiss_no_elimination, false) THEN
        _swiss_match_type := 'regular';
    ELSIF _wins = _wins_needed - 1 THEN
        _swiss_match_type := 'advancement';
    ELSIF _losses = _wins_needed - 1 THEN
        _swiss_match_type := 'elimination';
    ELSE
        _swiss_match_type := 'regular';
    END IF;

    RETURN get_bracket_best_of(_stage.id, _swiss_match_type, _bracket.round);
END;
$$;
