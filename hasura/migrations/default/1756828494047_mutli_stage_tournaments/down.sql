alter table "public"."tournament_teams" drop column if exists "created_at";
alter table "public"."tournament_stages" drop column if exists "groups";
alter table "public"."tournament_brackets" drop column if exists "group";
alter table "public"."tournament_brackets" drop column if exists "bye" boolean;
alter table "public"."tournament_brackets" drop column if exists "scheduled_eta";
