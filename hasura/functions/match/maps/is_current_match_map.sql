CREATE OR REPLACE FUNCTION public.is_current_match_map(match_map public.match_maps)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT match_map.id = (
        SELECT mm.id
        FROM match_maps mm
        WHERE mm.match_id = match_map.match_id
          AND mm.status != 'Finished'
        ORDER BY mm.order ASC
        LIMIT 1
    );
$$;
