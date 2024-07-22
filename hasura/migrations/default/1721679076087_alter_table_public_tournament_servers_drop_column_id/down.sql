alter table "public"."tournament_servers" alter column "id" set default gen_random_uuid();
alter table "public"."tournament_servers" alter column "id" drop not null;
alter table "public"."tournament_servers" add column "id" uuid;
