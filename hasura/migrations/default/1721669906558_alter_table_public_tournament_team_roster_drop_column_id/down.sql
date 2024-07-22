alter table "public"."tournament_team_roster" alter column "id" set default gen_random_uuid();
alter table "public"."tournament_team_roster" alter column "id" drop not null;
alter table "public"."tournament_team_roster" add column "id" uuid;
