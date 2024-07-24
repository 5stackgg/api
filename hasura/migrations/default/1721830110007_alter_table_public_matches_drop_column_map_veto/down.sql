alter table "public"."matches" alter column "map_veto" set default false;
alter table "public"."matches" alter column "map_veto" drop not null;
alter table "public"."matches" add column "map_veto" bool;
