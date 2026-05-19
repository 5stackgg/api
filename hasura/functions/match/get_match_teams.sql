CREATE OR REPLACE FUNCTION public.get_match_teams(match public.matches)
RETURNS SETOF public.teams
LANGUAGE sql
STABLE
AS $$
    SELECT DISTINCT t.*
    FROM match_lineups ml
    INNER JOIN teams t ON t.id = ml.team_id
    WHERE ml.match_id = match.id
      AND ml.team_id IS NOT NULL;
$$;
