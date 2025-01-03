alter table "public"."e_server_regions" rename to "server_regions";

alter table "public"."server_regions" add column "is_lan" boolean
 not null default 'false';
alter table "public"."server_regions" alter column "description" drop not null;
