alter table "public"."match_options" alter column "lan" set default false;
alter table "public"."match_options" alter column "lan" drop not null;
alter table "public"."match_options" add column "lan" bool;
