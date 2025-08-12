drop function if exists public.region_has_node(e_server_region public.server_regions);
CREATE OR REPLACE FUNCTION public.region_has_node(server_region public.server_regions) RETURNS BOOLEAN
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    has_node BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM game_server_nodes WHERE region = server_region.value AND enabled = true LIMIT 1
    ) INTO has_node;
    
    RETURN has_node;
END;
$$;