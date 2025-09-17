alter table "public"."game_server_nodes"
  add constraint "game_server_nodes_pin_plugin_version_fkey"
  foreign key ("pin_plugin_version")
  references "public"."plugin_versions"
  ("version") on update cascade on delete set null;
