CREATE OR REPLACE FUNCTION public.get_match_type_min_players(match_type TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    IF match_type = 'Competitive' THEN
        RETURN 5;
    ELSIF match_type = 'Wingman' THEN
        RETURN 2;
    ELSIF match_type = 'Duel' THEN
        RETURN 1;
    ELSE
         RAISE EXCEPTION 'Invalid match type: %', match_type USING ERRCODE = '22000';
    END IF;
END;
$$;
