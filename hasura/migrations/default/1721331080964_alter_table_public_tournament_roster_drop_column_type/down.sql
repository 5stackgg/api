alter table "public"."tournament_roster" alter column "type" drop not null;
alter table "public"."tournament_roster" add column "type" text;
