create or replace function game_server_node_plugin_supported(game_server_node game_server_nodes) returns boolean as $$
begin
  if game_server_node.build_id is null then
    return true;
  end if;

  return game_version_supports_plugin(game_server_node.build_id, game_server_node.pin_plugin_version);
end;
$$ language plpgsql stable;