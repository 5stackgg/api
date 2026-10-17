CREATE OR REPLACE FUNCTION public.match_options_tournament_ids(_match_options_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
AS $$
    SELECT t.id FROM tournaments t WHERE t.match_options_id = _match_options_id
    UNION
    SELECT ts.tournament_id FROM tournament_stages ts WHERE ts.match_options_id = _match_options_id
    UNION
    SELECT ts.tournament_id
    FROM tournament_brackets tb
    INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
    WHERE tb.match_options_id = _match_options_id;
$$;
