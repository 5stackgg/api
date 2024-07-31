CREATE OR REPLACE FUNCTION public.get_match_type_min_players(match_type TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
AS $function$
BEGIN
    IF match_type = 'Wingman' THEN
        RETURN 2;
    ELSE
        RETURN 5;
    END IF;
END;
$function$;
