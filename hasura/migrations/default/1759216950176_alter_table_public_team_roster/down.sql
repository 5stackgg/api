alter table "public"."team_roster" drop constraint "team_roster_status_fkey";

alter table "public"."team_roster" drop column "status";
alter table "public"."team_roster" drop column "coach";
