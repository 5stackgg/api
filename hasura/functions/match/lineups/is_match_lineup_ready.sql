CREATE OR REPLACE FUNCTION public.is_match_lineup_ready(match_lineup public.match_lineups)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    options public.match_options;
    total_checked_in int;
    _check_in_setting text;
BEGIN
    SELECT mo.*
    INTO options
    FROM matches m
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    WHERE m.id = match_lineup.match_id
    LIMIT 1;

    _check_in_setting := options.check_in_setting;

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

    RETURN total_checked_in >= get_match_options_min_players(options);
END;
$$;
