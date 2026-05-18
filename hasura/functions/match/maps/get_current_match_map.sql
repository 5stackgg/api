CREATE OR REPLACE FUNCTION public.get_current_match_map(match public.matches)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    SELECT mm.id
    FROM match_maps mm
    WHERE mm.match_id = match.id
      AND mm.status != 'Finished'
    ORDER BY mm.order ASC
    LIMIT 1;
$$;
