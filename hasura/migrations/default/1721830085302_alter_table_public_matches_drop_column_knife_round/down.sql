alter table "public"."matches" alter column "knife_round" drop not null;
alter table "public"."matches" add column "knife_round" bool;
