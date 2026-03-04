CREATE OR REPLACE FUNCTION public.should_auto_schedule(
    _tournament_stage_id uuid
)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    _tournament RECORD;
BEGIN
    SELECT t.status, t.auto_start INTO _tournament
    FROM tournaments t
    JOIN tournament_stages ts ON ts.tournament_id = t.id
    WHERE ts.id = _tournament_stage_id;

    RETURN _tournament.status != 'Paused' AND _tournament.auto_start;
END;
$$;
