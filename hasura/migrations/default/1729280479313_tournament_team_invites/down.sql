
alter table "public"."team_invites" add constraint "team_invites_id_key" unique ("id");

alter table "public"."tournament_team_invites" drop constraint "tournament_team_invites_invited_by_player_steam_id_fkey";

alter table "public"."tournament_team_invites" drop constraint "tournament_team_invites_steam_id_fkey";

alter table "public"."tournament_team_invites" drop constraint "tournament_team_invites_tournament_team_id_fkey";

DROP TABLE "public"."tournament_team_invites";

alter table "public"."team_invites" drop constraint "team_invites_team_id_steam_id_key";
