drop function if exists public.region_status(e_server_region public.server_regions);
CREATE OR REPLACE FUNCTION public.region_status(server_region public.server_regions) RETURNS TEXT
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    total_count INT;
    online_count INT;
    node_total_count INT;
    node_online_count INT;
BEGIN
    -- only nodes that are part of the match-making pool factor into region
    -- health: enabled, opted in via enabled_for_match_making, and physically
    -- able to host servers (a port range is set). GPU-only / opted-out nodes
    -- never host matches, so they must not drag a region into a degraded state.
    -- a node that IS in the pool but isn't accepting new matches
    -- (NotAcceptingNewMatches) counts as not-online here, so a drained match
    -- node correctly surfaces as a degraded region.
    SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'Online')
    INTO node_total_count, node_online_count
    FROM game_server_nodes
    WHERE region = server_region.value
      AND enabled = true
      AND enabled_for_match_making = true
      AND start_port_range IS NOT NULL
      AND end_port_range IS NOT NULL;

    SELECT COUNT(*), COUNT(*) FILTER (WHERE connected = true)
    INTO total_count, online_count
    FROM servers
    WHERE region = server_region.value AND enabled = true AND game_server_node_id IS NULL;

    IF total_count + node_total_count = 0 THEN
        RETURN 'Disabled';
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