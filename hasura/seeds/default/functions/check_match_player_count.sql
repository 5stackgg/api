CREATE OR REPLACE FUNCTION public.check_match_player_count(match matches) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    min_players INTEGER;
    lineup_1_count INTEGER;
    lineup_2_count INTEGER;
   	match_type VARCHAR(255);
BEGIN
	SELECT type into match_type
		from match_options
		where id = match.match_options_id;

	IF match.status = 'Live' or match.status = 'Scheduled' THEN
       SELECT COUNT(*) INTO lineup_1_count
               FROM match_lineup_players mlp
                where mlp.match_lineup_id = match.lineup_1_id;

        SELECT COUNT(*) INTO lineup_2_count
            FROM match_lineup_players mlp
            	where mlp.match_lineup_id = match.lineup_2_id;

        min_players := get_match_type_min_players(match_type);

        IF lineup_1_count < min_players OR  lineup_2_count < min_players THEN
            RAISE EXCEPTION USING ERRCODE= '22000', MESSAGE= 'Not enough players to schedule match';
        END IF;
    END IF;
END;
$$;