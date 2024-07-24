alter table "public"."matches" alter column "overtime" drop not null;
alter table "public"."matches" add column "overtime" bool;
