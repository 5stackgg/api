CREATE FUNCTION public.get_current_match_map(match public.matches) RETURNS uuid
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    match_map_id uuid;
BEGIN
    SELECT mm.id INTO match_map_id
    FROM match_maps mm
    WHERE mm.match_id = match.id
     and mm.status != 'Finished'
    ORDER BY mm.order ASC
    LIMIT 1;
    RETURN match_map_id;
END;
$$;