CREATE OR REPLACE FUNCTION public.team_last_match_at(team public.teams)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
    SELECT max(COALESCE(m.ended_at, m.started_at))
    FROM match_lineups ml
    INNER JOIN matches m ON m.id = ml.match_id
    WHERE ml.team_id = team.id
      AND m.started_at IS NOT NULL;
$$;
