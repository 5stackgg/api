CREATE TABLE "public"."match_messages" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "match_id" uuid NOT NULL, "message" text NOT NULL, "player_steam_id" bigint NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),  "updated_at" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("id") );
CREATE EXTENSION IF NOT EXISTS pgcrypto;
