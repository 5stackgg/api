CREATE OR REPLACE FUNCTION public.available_region_server_count(e_game_server_node_region public.e_game_server_node_regions) RETURNS INT
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    server_count INT;
BEGIN
    SELECT COUNT(*)
        INTO server_count
        FROM servers s
        WHERE s.game_server_node_id in(select id from game_server_nodes gsn where gsn.region = e_game_server_node_region.value) and s.reserved_by_match_id IS NULL;
    RETURN server_count;
END;
$$;