CREATE OR REPLACE FUNCTION public.create_match_lineups(match matches) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    _lineup_1_id UUID;
    _lineup_2_id UUID;
BEGIN
	IF match.lineup_1_id IS NULL THEN
	 INSERT INTO match_lineups DEFAULT VALUES RETURNING id INTO _lineup_1_id;
     match.lineup_1_id = _lineup_1_id;
	END IF;
	IF match.lineup_2_id IS NULL THEN
       INSERT INTO match_lineups DEFAULT VALUES RETURNING id INTO _lineup_2_id;
 	   match.lineup_2_id = _lineup_2_id;
	END IF;
END;
$$;