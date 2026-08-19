DROP INDEX IF EXISTS "public"."matches_counts_toward_ranking_idx";
DROP INDEX IF EXISTS "public"."custom_pages_plugin_slug_idx";
DROP INDEX IF EXISTS "public"."match_options_game_mode_idx";
DROP INDEX IF EXISTS "public"."game_modes_enabled_idx";
DROP INDEX IF EXISTS "public"."game_server_node_plugins_slug_idx";
DROP INDEX IF EXISTS "public"."game_plugins_kind_verified_idx";
DROP INDEX IF EXISTS "public"."game_plugin_versions_runtime_published_idx";

ALTER TABLE "public"."matches" DROP COLUMN IF EXISTS "counts_toward_ranking";

ALTER TABLE "public"."game_server_nodes" DROP COLUMN IF EXISTS "plugins_synced_at";

ALTER TABLE "public"."custom_pages" DROP COLUMN IF EXISTS "plugin_slug";

ALTER TABLE "public"."servers" DROP CONSTRAINT IF EXISTS "servers_ranked_has_no_game_mode_check";
ALTER TABLE "public"."servers" DROP CONSTRAINT IF EXISTS "servers_game_mode_fkey";
ALTER TABLE "public"."servers" DROP COLUMN IF EXISTS "plugins_checked_at";
ALTER TABLE "public"."servers" DROP COLUMN IF EXISTS "loaded_plugins";
ALTER TABLE "public"."servers" DROP COLUMN IF EXISTS "game_mode_id";

ALTER TABLE "public"."match_options" DROP CONSTRAINT IF EXISTS "match_options_game_mode_fkey";
ALTER TABLE "public"."match_options" DROP COLUMN IF EXISTS "game_mode_id";

DROP TABLE IF EXISTS "public"."game_mode_plugins";
DROP TABLE IF EXISTS "public"."game_modes";
DROP TABLE IF EXISTS "public"."game_server_node_plugins";
DROP TABLE IF EXISTS "public"."game_plugin_installs";
DROP TABLE IF EXISTS "public"."game_plugin_versions";
DROP TABLE IF EXISTS "public"."game_plugins";
DROP TABLE IF EXISTS "public"."e_game_plugin_channels";
DROP TABLE IF EXISTS "public"."e_game_plugin_install_statuses";
DROP TABLE IF EXISTS "public"."e_game_plugin_kinds";
