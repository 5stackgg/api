CREATE OR REPLACE FUNCTION public.match_max_players_per_lineup(match matches)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
    SELECT get_match_type_min_players(mo.type) + COALESCE(mo.number_of_substitutes, 0)
    FROM match_options mo
    WHERE mo.id = match.match_options_id;
$$;

CREATE OR REPLACE FUNCTION public.match_min_players_per_lineup(match matches)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
    SELECT get_match_type_min_players(mo.type)
    FROM match_options mo
    WHERE mo.id = match.match_options_id;
$$;

CREATE OR REPLACE FUNCTION public.tournament_max_players_per_lineup(tournament tournaments)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
    SELECT get_match_type_min_players(mo.type) + COALESCE(mo.number_of_substitutes, 0)
    FROM match_options mo
    WHERE mo.id = tournament.match_options_id;
$$;

CREATE OR REPLACE FUNCTION public.tournament_min_players_per_lineup(tournament tournaments)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
    SELECT get_match_type_min_players(mo.type)
    FROM match_options mo
    WHERE mo.id = tournament.match_options_id;
$$;
