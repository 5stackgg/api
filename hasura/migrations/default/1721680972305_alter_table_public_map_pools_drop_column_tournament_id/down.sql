alter table "public"."map_pools"
  add constraint "map_pools_tournament_id_fkey"
  foreign key (tournament_id)
  references "public"."tournaments"
  (id) on update cascade on delete cascade;
alter table "public"."map_pools" alter column "tournament_id" drop not null;
alter table "public"."map_pools" add column "tournament_id" uuid;
