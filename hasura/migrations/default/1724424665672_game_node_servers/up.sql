
CREATE TABLE "public"."game_server_nodes" ("id" text NOT NULL DEFAULT gen_random_uuid(), "start_port_range" integer, "end_port_range" integer, "region" text DEFAULT 'Lan', "status" text DEFAULT 'Setup', "enabled" boolean NOT NULL DEFAULT true, PRIMARY KEY ("id") );

CREATE TABLE "public"."e_game_server_node_regions" ("value" text NOT NULL, "description" text NOT NULL, PRIMARY KEY ("value") );

CREATE TABLE "public"."e_game_server_node_statuses" ("value" text NOT NULL, "description" text NOT NULL, PRIMARY KEY ("value") );

alter table "public"."game_server_nodes"
  add constraint "game_server_nodes_region_fkey"
  foreign key ("region")
  references "public"."e_game_server_node_regions"
  ("value") on update cascade on delete restrict;

alter table "public"."game_server_nodes"
  add constraint "game_server_nodes_status_fkey"
  foreign key ("status")
  references "public"."e_game_server_node_statuses"
  ("value") on update cascade on delete restrict;