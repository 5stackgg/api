CREATE OR REPLACE FUNCTION public.tbi_match() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    _lineup_1_id UUID;
    _lineup_2_id UUID;
BEGIN
	IF NEW.lineup_1_id IS NULL THEN
	 INSERT INTO match_lineups DEFAULT VALUES RETURNING id INTO _lineup_1_id;
     NEW.lineup_1_id = _lineup_1_id;
	END IF;
	IF NEW.lineup_2_id IS NULL THEN
       INSERT INTO match_lineups DEFAULT VALUES RETURNING id INTO _lineup_2_id;
 	   NEW.lineup_2_id = _lineup_2_id;
	END IF;
    RETURN NEW;
END;
$$;