CREATE OR REPLACE FUNCTION public.region_status(e_server_region public.e_server_regions) RETURNS TEXT
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    total_count INT;
    online_count INT;
    node_total_count INT;
    node_online_count INT;
BEGIN
    SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'Online')
    INTO node_total_count, node_online_count
    FROM game_server_nodes
    WHERE region = e_server_region.value and enabled = true;

    SELECT COUNT(*), COUNT(*) FILTER (WHERE connected = true)
    INTO total_count, online_count
    FROM servers
    WHERE region = e_server_region.value AND enabled = true AND game_server_node_id IS NULL;

    IF total_count + node_total_count = 0 THEN
        RETURN 'N/A';
    END IF;

    IF (node_online_count + online_count) = (total_count + node_total_count) THEN
        RETURN 'Online';
    ELSIF node_online_count + online_count > 0 THEN
        RETURN 'Partial';
    ELSE
        RETURN 'Offline';
    END IF;
END;
$$;