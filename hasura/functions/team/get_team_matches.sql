CREATE OR REPLACE FUNCTION public.get_team_matches(team public.teams)
RETURNS SETOF public.matches
LANGUAGE sql
STABLE
AS $$
    SELECT DISTINCT m.*
    FROM match_lineups ml
    INNER JOIN matches m ON m.id = ml.match_id
    WHERE ml.team_id = team.id;
$$;
