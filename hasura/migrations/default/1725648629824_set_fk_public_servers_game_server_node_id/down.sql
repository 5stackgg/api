alter table "public"."servers" drop constraint "servers_game_server_node_id_fkey",
  add constraint "servers_game_server_node_fkey"
  foreign key ("game_server_node_id")
  references "public"."game_server_nodes"
  ("id") on update cascade on delete restrict;
