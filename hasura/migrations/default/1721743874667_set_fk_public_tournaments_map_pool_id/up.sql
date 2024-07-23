alter table "public"."tournaments"
  add constraint "tournaments_map_pool_id_fkey"
  foreign key ("map_pool_id")
  references "public"."map_pools"
  ("id") on update cascade on delete restrict;
