CREATE OR REPLACE FUNCTION resolve_match_auto_cancel(_match_id uuid)
RETURNS TABLE(auto_cancellation boolean, auto_cancel_duration int) AS $$
DECLARE
    _tournament_mo_id uuid;
BEGIN
    SELECT t.match_options_id
    INTO _tournament_mo_id
    FROM tournament_brackets tb
    INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
    INNER JOIN tournaments t        ON t.id = ts.tournament_id
    WHERE tb.match_id = _match_id;

    IF _tournament_mo_id IS NOT NULL THEN
        RETURN QUERY
        SELECT mo.auto_cancellation, mo.auto_cancel_duration
        FROM match_options mo
        WHERE mo.id = _tournament_mo_id;
        RETURN;
    END IF;

    RETURN QUERY
    SELECT mo.auto_cancellation, mo.auto_cancel_duration
    FROM matches m
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    WHERE m.id = _match_id;
END;
$$ LANGUAGE plpgsql STABLE;
