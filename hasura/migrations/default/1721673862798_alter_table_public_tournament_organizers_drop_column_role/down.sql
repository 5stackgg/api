alter table "public"."tournament_organizers" alter column "role" set default ''Admin'::text';
alter table "public"."tournament_organizers" alter column "role" drop not null;
alter table "public"."tournament_organizers" add column "role" text;
