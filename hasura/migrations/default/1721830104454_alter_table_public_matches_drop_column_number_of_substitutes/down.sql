alter table "public"."matches" alter column "number_of_substitutes" set default 0;
alter table "public"."matches" alter column "number_of_substitutes" drop not null;
alter table "public"."matches" add column "number_of_substitutes" int4;
