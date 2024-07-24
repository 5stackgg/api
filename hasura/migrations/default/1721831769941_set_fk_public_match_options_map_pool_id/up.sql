alter table "public"."match_options"
  add constraint "match_options_map_pool_id_fkey"
  foreign key ("map_pool_id")
  references "public"."map_pools"
  ("id") on update cascade on delete restrict;
