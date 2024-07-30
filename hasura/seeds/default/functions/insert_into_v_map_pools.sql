CREATE OR REPLACE FUNCTION public.insert_into_v_map_pools() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 	INSERT INTO _map_pool (map_id, map_pool_id)
    VALUES (NEW.id, NEW.map_pool_id);
    RETURN NULL;
END;
$$;