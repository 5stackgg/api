CREATE OR REPLACE FUNCTION public.region_status(e_game_server_node_region public.e_game_server_node_regions) RETURNS TEXT
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    status_count INT;
    online_count INT;
BEGIN
    SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'Online')
    INTO status_count, online_count
    FROM game_server_nodes
    WHERE region = e_game_server_node_region.value;

    IF status_count = 0 THEN
        RETURN 'N/A';
    END IF;

    IF online_count = status_count THEN
        RETURN 'Online';
    ELSIF online_count > 0 THEN
        RETURN 'Partial';
    ELSE
        RETURN 'Offline';
    END IF;
END;
$$;