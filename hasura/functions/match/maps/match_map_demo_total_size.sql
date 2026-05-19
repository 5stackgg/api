CREATE OR REPLACE FUNCTION public.match_map_demo_total_size(match_map public.match_maps)
RETURNS int
LANGUAGE sql
STABLE
AS $$
    SELECT SUM(size)::int
    FROM match_map_demos
    WHERE match_map_id = match_map.id;
$$;
