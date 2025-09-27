alter table "public"."servers" drop constraint "servers_type_fkey";

alter table "public"."servers" drop column "is_dedicated";

alter table "public"."servers" drop column "type";

drop table if exists public.e_server_types; 

