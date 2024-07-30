CREATE OR REPLACE FUNCTION public.check_match_player_count(match matches) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    player_count INTEGER;
    max_players INTEGER;
   	match_type VARCHAR(255);
BEGIN
	SELECT type into match_type
		from match_options
		where id = match.match_options_id;
	IF match_type = 'Scrimmage' or match.status = 'PickingPlayers' or match.status = 'Canceled' THEN
        return;
    END IF;
    SELECT COUNT(*) INTO player_count
    FROM match_lineup_players mlp
    	INNER JOIN v_match_lineups ml on ml.id = mlp.match_lineup_id
    	INNER JOIN matches m on m.id = ml.match_id
    	where m.id = match.id;
	max_players := 10;
    IF match_type = 'Wingman' THEN
        max_players := 4;
    END IF;
	IF player_count < max_players THEN
		RAISE EXCEPTION USING ERRCODE= '22000', MESSAGE= 'Not enough players to schedule match';
    END IF;
END;
$$;