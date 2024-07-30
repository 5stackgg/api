CREATE OR REPLACE FUNCTION public.tbu_match_player_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    player_count INTEGER;
    max_players INTEGER;
   	match_type VARCHAR(255);
BEGIN
	SELECT type into match_type
		from match_options
		where id = NEW.match_options_id;
	IF match_type = 'Scrimmage' or NEW.status = 'PickingPlayers' or NEW.status = 'Canceled' THEN
        return NEW;
    END IF;
    SELECT COUNT(*) INTO player_count
    FROM match_lineup_players mlp
    	INNER JOIN v_match_lineups ml on ml.id = mlp.match_lineup_id
    	INNER JOIN matches m on m.id = ml.match_id
    	where m.id = NEW.id;
	max_players := 10;
    IF match_type = 'Wingman' THEN
        max_players := 4;
    END IF;
	IF player_count < max_players THEN
		RAISE EXCEPTION USING ERRCODE= '22000', MESSAGE= 'Not enough players to schedule match';
    END IF;
    RETURN NEW;
END;
$$;