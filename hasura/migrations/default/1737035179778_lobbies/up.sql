CREATE TABLE "public"."lobbies" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "access" text NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("id") );
CREATE EXTENSION IF NOT EXISTS pgcrypto;

alter table "public"."lobbies"
  add constraint "lobbies_access_fkey"
  foreign key ("access")
  references "public"."e_lobby_access"
  ("value") on update cascade on delete restrict;

CREATE TABLE "public"."lobby_players" ("lobby_id" uuid NOT NULL, "steam_id" bigint NOT NULL, "captain" boolean NOT NULL default false, "status" text NOT NULL DEFAULT 'Invite', "invited_by_steam_id" bigint, PRIMARY KEY ("steam_id", "lobby_id"), FOREIGN KEY ("steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade, FOREIGN KEY ("lobby_id") REFERENCES "public"."lobbies"("id") ON UPDATE cascade ON DELETE cascade);

CREATE TABLE "public"."e_lobby_player_status" ("value" text NOT NULL, "description" Text NOT NULL, PRIMARY KEY ("value") , UNIQUE ("value"));

alter table "public"."lobby_players"
  add constraint "lobby_players_status_fkey"
  foreign key ("status")
  references "public"."e_lobby_player_status"
  ("value") on update cascade on delete restrict;
