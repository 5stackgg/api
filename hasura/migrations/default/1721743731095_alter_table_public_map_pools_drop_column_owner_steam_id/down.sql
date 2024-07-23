alter table "public"."map_pools" alter column "owner_steam_id" drop not null;
alter table "public"."map_pools" add column "owner_steam_id" int8;
