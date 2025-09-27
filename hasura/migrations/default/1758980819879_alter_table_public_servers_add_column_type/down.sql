alter table "public"."servers" drop constraint "servers_type_fkey";

alter table "public"."servers" drop column "type";
alter table "public"."servers" drop column "connect_password";
alter table "public"."servers" drop column "is_dedicated";
alter table "public"."servers" drop column "max_players";

drop table if exists public.e_server_types; 

