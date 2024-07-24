alter table "public"."matches" alter column "mr" drop not null;
alter table "public"."matches" add column "mr" int4;
