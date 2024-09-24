CREATE OR REPLACE FUNCTION public.match_max_players_per_lineup(match matches)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
AS $$
DECLARE
    match_type text;
    number_of_substitutes int :=0;
BEGIN
    select mo.type, mo.number_of_substitutes into match_type, number_of_substitutes from match_options mo
        where mo.id = match.match_options_id;

    return get_match_type_min_players(match_type) + number_of_substitutes;
END;
$$;

CREATE OR REPLACE FUNCTION public.match_min_players_per_lineup(match matches)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
AS $$
DECLARE
    match_type text;
BEGIN
    select mo.type into match_type from match_options mo
        where mo.id = match.match_options_id;

    return get_match_type_min_players(match_type);
END;
$$;


CREATE OR REPLACE FUNCTION public.tournament_max_players_per_lineup(tournament tournaments)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
AS $$
DECLARE
    match_type text;
    number_of_substitutes int :=0;
BEGIN
    select mo.type, mo.number_of_substitutes into match_type, number_of_substitutes from match_options mo
        where mo.id = tournament.match_options_id;

    return get_match_type_min_players(match_type) + number_of_substitutes;
END;
$$;

CREATE OR REPLACE FUNCTION public.tournamen_min_players_per_lineup(tournament tournaments)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
AS $$
DECLARE
    match_type text;
BEGIN
    select mo.type into match_type from match_options mo
        where mo.id = tournament.match_options_id;

    return get_match_type_min_players(match_type);
END;
$$;

