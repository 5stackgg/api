alter table "public"."map_pools"
  add constraint "map_pools_tournament_id_fkey"
  foreign key ("tournament_id")
  references "public"."tournaments"
  ("id") on update cascade on delete cascade;
