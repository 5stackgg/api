CREATE OR REPLACE FUNCTION public.check_match_status(match matches) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    best_of int;
    map_veto boolean;
    match_map_count int;
BEGIN
    IF (match.status != 'Live' AND match.status != 'Veto') OR match.server_id IS NULL THEN
        RETURN match;
    END IF;
    SELECT mo.map_veto, mo.best_of INTO map_veto, best_of FROM matches m
        inner join match_options mo on mo.id = m.match_options_id
     WHERE m.id = match.id;
    IF map_veto = FALSE THEN
        SELECT COUNT(*) INTO match_map_count FROM match_maps WHERE match_id = match.id;
        IF match_map_count != best_of THEN
            RAISE EXCEPTION 'Cannot start match because a map needs to be selected' USING ERRCODE = '22000';
        END IF;
    END IF;
    IF NOT is_server_available(match.id, match.server_id) THEN
        RAISE EXCEPTION 'Cannot start match because a server is not available' USING ERRCODE = '22000';
    END IF;
    RETURN match;
END;
$$;