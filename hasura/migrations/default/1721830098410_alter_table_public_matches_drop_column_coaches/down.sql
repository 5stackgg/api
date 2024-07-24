alter table "public"."matches" alter column "coaches" set default false;
alter table "public"."matches" alter column "coaches" drop not null;
alter table "public"."matches" add column "coaches" bool;
