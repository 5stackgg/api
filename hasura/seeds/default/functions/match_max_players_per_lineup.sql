CREATE OR REPLACE FUNCTION public.match_max_players_per_lineup(match matches)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    allowed int :=5;
    match_type text;
    number_of_substitutes int :=0;
BEGIN
    select mo.type, mo.number_of_substitutes into match_type, number_of_substitutes from match_options mo
        where mo.id = match.match_options_id;

    IF match_type = 'Wingman' THEN
        allowed = 2;
    END IF;

    return  allowed + number_of_substitutes;
END;
$function$
