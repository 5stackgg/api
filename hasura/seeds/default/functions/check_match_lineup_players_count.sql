CREATE OR REPLACE FUNCTION public.check_match_lineup_players_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    lineup_count INTEGER;
    max_players INTEGER;
   match_type VARCHAR(255);
	substitutes INTEGER;
BEGIN
    SELECT mo.type, mo.number_of_substitutes INTO match_type, substitutes
    FROM matches m
    INNER JOIN match_options mo on mo.id = m.match_options_id
    inner join v_match_lineups ml on ml.match_id = m.id
    WHERE ml.id = NEW.match_lineup_id;
    max_players := 5;
    IF match_type = 'Wingman' THEN
        max_players := 2;
    END IF;
  	max_players := max_players + substitutes;
    SELECT COUNT(*) INTO lineup_count
    FROM match_lineup_players
    WHERE match_lineup_id = NEW.match_lineup_id;
    IF lineup_count >= max_players THEN
		RAISE EXCEPTION USING ERRCODE= '22000', MESSAGE= 'Max number of players reached';
    END IF;
    RETURN NEW;
END;
$$;