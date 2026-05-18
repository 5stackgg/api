CREATE OR REPLACE FUNCTION public.total_node_server_count(game_server_node public.game_server_nodes)
RETURNS int
LANGUAGE sql
STABLE
AS $$
    SELECT COUNT(*)::int
    FROM servers s
    WHERE s.game_server_node_id = game_server_node.id
      AND s.enabled = true;
$$;
