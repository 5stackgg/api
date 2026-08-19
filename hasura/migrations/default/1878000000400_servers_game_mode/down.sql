DROP INDEX IF EXISTS "public"."custom_pages_plugin_slug_idx";

ALTER TABLE "public"."custom_pages"
    DROP COLUMN IF EXISTS "plugin_slug";

ALTER TABLE "public"."servers"
    DROP CONSTRAINT IF EXISTS "servers_ranked_has_no_game_mode_check";

ALTER TABLE "public"."servers"
    DROP CONSTRAINT IF EXISTS "servers_game_mode_fkey";

ALTER TABLE "public"."servers"
    DROP COLUMN IF EXISTS "game_mode_id";
