alter table "public"."server_regions" rename to "e_server_regions";

alter table "public"."server_regions" drop column "is_lan";
alter table "public"."server_regions" alter column "description" set not null;
