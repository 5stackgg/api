CREATE OR REPLACE FUNCTION public.available_node_server_count(game_server_node public.game_server_nodes) RETURNS INT
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    server_count INT;
BEGIN
    SELECT COUNT(*)
    INTO server_count
    FROM servers s
    WHERE s.game_server_node_id = game_server_node.id and s.reserved_by_match_id IS NULL
    and s.type = 'Ranked';

    RETURN server_count;
END;
$$;