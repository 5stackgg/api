CREATE OR REPLACE FUNCTION public.match_map_demo_total_size(match_map public.match_maps)
RETURNS int
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    total_size int;
BEGIN
    select SUM(size) into total_size from match_map_demos where match_map_id = match_map.id;
    return total_size;
END;
$$;
