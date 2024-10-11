alter table "public"."servers" add column "is_on_demand" bool default false;
alter table "public"."servers" drop column "game_server_node_id";
alter table "public"."servers" drop column "reserved_by_match_id";

DROP TABLE "public"."game_server_nodes";
DROP TABLE "public"."e_server_regions";
DROP TABLE "public"."e_game_server_node_statuses";
