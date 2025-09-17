DROP TABLE IF EXISTS "public"."plugin_versions";

CREATE TABLE IF NOT EXISTS "public"."plugin_versions" (
  "version" text NOT NULL,
  "min_game_build_id" integer,
  "published_at" timestamptz NOT NULL,
  PRIMARY KEY ("version")
);

alter table "public"."game_server_nodes" add column if not exists "pin_plugin_version" text
 null;