alter table "public"."tournament_servers" add constraint "tournament_servers_server_id_tournament_id_key" unique ("server_id", "tournament_id");
