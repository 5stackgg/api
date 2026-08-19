ALTER TABLE "public"."game_server_nodes"
    DROP COLUMN IF EXISTS "plugins_synced_at";

DROP TABLE IF EXISTS "public"."game_plugin_installs";
