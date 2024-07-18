alter table "public"."tournaments" alter column "type" drop not null;
alter table "public"."tournaments" add column "type" text;
