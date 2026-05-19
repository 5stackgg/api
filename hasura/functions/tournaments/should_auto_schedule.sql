CREATE OR REPLACE FUNCTION public.should_auto_schedule(_tournament_stage_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(t.status != 'Paused' AND t.auto_start, false)
    FROM tournaments t
    JOIN tournament_stages ts ON ts.tournament_id = t.id
    WHERE ts.id = _tournament_stage_id;
$$;
