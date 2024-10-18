
alter table "public"."team_invites" add constraint "team_invites_team_id_steam_id_key" unique ("team_id", "steam_id");

CREATE TABLE "public"."tournament_team_invites" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "tournament_team_id" uuid NOT NULL, "steam_id" bigint NOT NULL, "invited_by_player_steam_id" bigint NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("id") , UNIQUE ("steam_id", "tournament_team_id"));
CREATE EXTENSION IF NOT EXISTS pgcrypto;

alter table "public"."tournament_team_invites"
  add constraint "tournament_team_invites_tournament_team_id_fkey"
  foreign key ("tournament_team_id")
  references "public"."tournament_teams"
  ("id") on update cascade on delete cascade;

alter table "public"."tournament_team_invites"
  add constraint "tournament_team_invites_steam_id_fkey"
  foreign key ("steam_id")
  references "public"."players"
  ("steam_id") on update cascade on delete cascade;

alter table "public"."tournament_team_invites"
  add constraint "tournament_team_invites_invited_by_player_steam_id_fkey"
  foreign key ("invited_by_player_steam_id")
  references "public"."players"
  ("steam_id") on update cascade on delete cascade;

alter table "public"."team_invites" drop constraint "team_invites_id_key";
