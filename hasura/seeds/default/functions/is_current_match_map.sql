CREATE OR REPLACE FUNCTION public.is_current_match_map(match_map public.match_maps) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    match_map_id uuid;
BEGIN
    SELECT mm.id INTO match_map_id
        FROM match_maps mm
        WHERE mm.match_id = match_map.match_id
         and mm.status != 'Finished'
        ORDER BY mm.order ASC
        LIMIT 1;

        IF match_map_id = match_map.id THEN
            return true;
        END IF;
        return false;
END;
$$;