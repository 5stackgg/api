CREATE FUNCTION public.get_lineup_match(match_lineup public.match_lineups) RETURNS public.matches
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    match public.matches;
BEGIN
     SELECT m.id INTO match
        FROM matches m
        INNER JOIN match_lineups ml ON ml.id = m.lineup_1_id OR ml.id = m.lineup_2_id;
        return match;
END;
$$;