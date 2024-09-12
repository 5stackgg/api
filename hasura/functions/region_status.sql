CREATE OR REPLACE FUNCTION public.region_status(e_game_server_node_region public.e_game_server_node_regions) RETURNS INT
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    server_count INT;
BEGIN
    select status from game_server_node_region_status where e_region = e_game_server_node_region.value;

    if count === 0 then
        return 'N/A';
    end if;

    if all statues === online then 
        return 'Online';
    else
        return 'Partial';
    end if;

    return 'Offline';
END;
$$;