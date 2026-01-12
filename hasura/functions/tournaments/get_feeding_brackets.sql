CREATE OR REPLACE FUNCTION get_feeding_brackets(tournament_bracket public.tournament_brackets)
RETURNS SETOF public.tournament_brackets
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM tournament_brackets WHERE loser_parent_bracket_id = tournament_bracket.id OR parent_bracket_id = tournament_bracket.id;
END;
$$;