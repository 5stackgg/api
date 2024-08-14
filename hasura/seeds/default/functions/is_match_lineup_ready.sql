CREATE OR REPLACE FUNCTION public.is_match_lineup_ready(match_lineup public.match_lineups)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    match_type text;
    total_checked_in int;
    match_id int;
BEGIN
    SELECT mo.type
    INTO match_type
    FROM matches m
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    WHERE m.lineup_1_id = match_lineup.id OR m.lineup_2_id = match_lineup.id;

    SELECT count(*)
    INTO total_checked_in
    FROM match_lineup_players mlp
    WHERE mlp.match_lineup_id = match_lineup.id AND mlp.checked_in = true;

    return total_checked_in >= get_match_type_min_players(match_type);
END;
$$;
