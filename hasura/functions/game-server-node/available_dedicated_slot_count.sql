-- Must match the free-slot lookup in tbiud_servers, which is what a dedicated
-- server moving onto this node actually claims.
CREATE OR REPLACE FUNCTION public.available_dedicated_slot_count(game_server_node public.game_server_nodes)
RETURNS int
LANGUAGE sql
STABLE
AS $$
    SELECT COUNT(*)::int
    FROM servers s
    WHERE s.game_server_node_id = game_server_node.id
      AND s.is_dedicated = false
      AND s.reserved_by_match_id IS NULL
      AND s.enabled = true
      AND NOT EXISTS (
          SELECT 1 FROM servers s2
          WHERE s2.game_server_node_id = game_server_node.id
            AND s2.port = s.port
            AND s2.tv_port = s.tv_port
            AND s2.is_dedicated = true
      );
$$;
