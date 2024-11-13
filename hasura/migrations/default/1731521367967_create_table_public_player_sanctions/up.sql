CREATE TABLE IF NOT EXISTS "public"."player_sanctions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "player_steam_id" bigint NOT NULL, "type" text NOT NULL, "reason" text, "remove_sanction_date" timestamptz, "sanctioned_by_steam_id" bigint NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("id") , FOREIGN KEY ("player_steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade, FOREIGN KEY ("sanctioned_by_steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade);
CREATE EXTENSION IF NOT EXISTS pgcrypto;


alter table "public"."player_sanctions" drop constraint "player_sanctions_sanctioned_by_steam_id_fkey",
  add constraint "player_sanctions_sanctioned_by_steam_id_fkey"
  foreign key ("sanctioned_by_steam_id")
  references "public"."players"
  ("steam_id") on update cascade on delete set null;
