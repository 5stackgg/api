CREATE OR REPLACE FUNCTION public.get_team_matches(team public.teams) RETURNS SETOF public.matches
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
BEGIN
    RETURN QUERY
    SELECT DISTINCT m.*
       FROM teams t
       INNER JOIN v_match_lineups ml on ml.team_id = t.id
       INNER JOIN matches m ON m.id = ml.match_id
       where t.id = team.id;
END;
$$;