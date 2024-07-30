CREATE FUNCTION public.get_match_teams(match public.matches) RETURNS SETOF public.teams
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
BEGIN
    RETURN QUERY
    SELECT DISTINCT t.*
    FROM public.matches m
    INNER JOIN v_match_lineups ml ON ml.match_id = m.id
    INNER JOIN teams t ON t.id = ml.team_id
    WHERE ml.team_id IS NOT NULL
    and m.id = match.id;
END;
$$;