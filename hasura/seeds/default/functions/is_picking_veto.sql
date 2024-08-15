CREATE OR REPLACE FUNCTION public.lineup_is_picking_veto(match_lineup match_lineups)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
    _match matches;
BEGIN
    SELECT * INTO _match
    FROM matches
    WHERE lineup_1_id = match_lineup.id
       OR lineup_2_id = match_lineup.id
    LIMIT 1;

    RETURN get_veto_picking_lineup_id(_match) = match_lineup.id;
END;
$$;
