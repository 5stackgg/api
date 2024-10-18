CREATE OR REPLACE FUNCTION public.check_match_lineup_players_count(match_lineup_player match_lineup_players)
 RETURNS INT
 LANGUAGE plpgsql
AS $$
DECLARE
    match public.matches;
    lineup_count INTEGER;
    max_players INTEGER;
    match_type VARCHAR(255);
	substitutes INTEGER;
BEGIN
    SELECT m.* INTO match
        FROM matches m
        inner join v_match_lineups ml on ml.match_id = m.id
        WHERE ml.id = match_lineup_player.match_lineup_id;

  	max_players := match_max_players_per_lineup(match);

    SELECT COUNT(*) INTO lineup_count
    FROM match_lineup_players
    WHERE match_lineup_id = match_lineup_player.match_lineup_id;

    IF lineup_count >= max_players THEN
		RAISE EXCEPTION USING ERRCODE= '22000', MESSAGE= 'Max number of players reached';
    END IF;

    return lineup_count;
END;
$$
