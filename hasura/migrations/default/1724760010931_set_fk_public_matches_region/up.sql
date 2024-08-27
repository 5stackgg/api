alter table "public"."matches"
  add constraint "matches_region_fkey"
  foreign key ("region")
  references "public"."e_game_server_node_regions"
  ("value") on update cascade on delete restrict;
