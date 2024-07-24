alter table "public"."matches" alter column "best_of" drop not null;
alter table "public"."matches" add column "best_of" int4;
