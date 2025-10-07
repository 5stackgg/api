CREATE OR REPLACE FUNCTION public.is_match_lineup_ready(match_lineup public.match_lineups)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    match_type text;
    total_checked_in int;
    _check_in_setting text;
BEGIN
    SELECT mo.type, mo.check_in_setting
    INTO match_type, _check_in_setting
    FROM matches m
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    WHERE m.lineup_1_id = match_lineup.id OR m.lineup_2_id = match_lineup.id
    LIMIT 1;

    IF _check_in_setting = 'Captains' THEN
        SELECT count(*)
        INTO total_checked_in
        FROM match_lineup_players mlp
        WHERE mlp.match_lineup_id = match_lineup.id AND mlp.checked_in = true
        AND mlp.captain = true;

        RETURN total_checked_in = 1;
    END IF;

    SELECT count(*)
    INTO total_checked_in
    FROM match_lineup_players mlp
    WHERE mlp.match_lineup_id = match_lineup.id AND mlp.checked_in = true;

    RETURN total_checked_in >= get_match_type_min_players(match_type);
END;
$$;
