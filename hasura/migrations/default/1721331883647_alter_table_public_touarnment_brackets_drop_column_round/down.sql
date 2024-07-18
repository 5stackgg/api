alter table "public"."touarnment_brackets" alter column "round" drop not null;
alter table "public"."touarnment_brackets" add column "round" int4;
