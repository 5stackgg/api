CREATE OR REPLACE FUNCTION public.is_dedicated_server(server public.servers)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    IF server.game_server_node_id IS NULL THEN
        RETURN true;
    ELSE
        RETURN false;
    END IF;
END
$$;
