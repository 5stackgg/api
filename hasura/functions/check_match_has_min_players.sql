CREATE OR REPLACE FUNCTION public.check_match_has_min_players(match matches) RETURNS BOOLEAN
    LANGUAGE plpgsql
    AS $$
DECLARE
    min_players INTEGER;
    lineup_1_count INTEGER;
    lineup_2_count INTEGER;
    match_type VARCHAR(255);
BEGIN
    SELECT type INTO match_type
    FROM match_options
    WHERE id = match.match_options_id;

    SELECT COUNT(*) INTO lineup_1_count
            FROM match_lineup_players mlp
            where mlp.match_lineup_id = match.lineup_1_id;

    SELECT COUNT(*) INTO lineup_2_count
        FROM match_lineup_players mlp
            where mlp.match_lineup_id = match.lineup_2_id;

    min_players := get_match_type_min_players(match_type);

    IF lineup_1_count < min_players OR lineup_2_count < min_players THEN
        RETURN false;
    END IF;

    RETURN true;
END;
$$;