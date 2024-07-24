alter table "public"."matches"
  add constraint "matches_map_pool_id_fkey"
  foreign key (map_pool_id)
  references "public"."map_pools"
  (id) on update cascade on delete set null;
alter table "public"."matches" alter column "map_pool_id" drop not null;
alter table "public"."matches" add column "map_pool_id" uuid;
