DROP TABLE IF EXISTS "public"."game_versions";

CREATE TABLE IF NOT EXISTS "public"."game_versions" (
  "build_id" integer NOT NULL,
  "version" text NOT NULL,
  "description" text NOT NULL,
  "current" boolean,
  "downloads" jsonb,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("build_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_game_versions_current
  ON "public"."game_versions" (current)
  WHERE current IS TRUE;

alter table "public"."game_server_nodes" drop column if exists "pin_build_id";

alter table "public"."game_server_nodes" add column if not exists "pin_build_id" integer
 null;
