alter table "public"."map_pools"
  add constraint "map_pools_type_fkey"
  foreign key ("type")
  references "public"."e_match_types"
  ("value") on update cascade on delete restrict;
