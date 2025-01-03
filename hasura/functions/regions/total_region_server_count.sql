drop function if exists public.total_region_server_count(e_server_region public.server_regions);
CREATE OR REPLACE FUNCTION public.total_region_server_count(server_region public.server_regions) RETURNS INT
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    server_count INT;
BEGIN
    SELECT COUNT(*)
    INTO server_count
    FROM servers s
    LEFT JOIN 
        game_server_nodes gsn ON gsn.id = s.game_server_node_id
    WHERE s.region = server_region.value
    AND s.enabled = true
    AND 
        (gsn.id IS NULL OR gsn.enabled = true);
            
    RETURN server_count;
END;
$$;