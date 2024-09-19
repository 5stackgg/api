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

	IF match.status = 'Scheduled' THEN
        IF NOT check_match_has_min_players(match) THEN
            RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Not enough players to schedule match';
        END IF;
    END IF;
END;
$$;