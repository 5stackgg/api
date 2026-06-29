drop function if exists public.region_has_node(e_server_region public.server_regions);
CREATE OR REPLACE FUNCTION public.region_has_node(server_region public.server_regions)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM game_server_nodes
        WHERE region = server_region.value
          AND enabled = true
          AND enabled_for_match_making = true
          AND start_port_range IS NOT NULL
          AND end_port_range IS NOT NULL
    );
$$;
