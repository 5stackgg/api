-- History outlives the game version: CheckGameUpdate deletes a build's
-- game_versions row once Steam stops listing it, which used to cascade the
-- previous build's validation away before the next one could be compared to it.
ALTER TABLE "public"."gamedata_signature_validations"
    DROP CONSTRAINT IF EXISTS "gamedata_signature_validations_build_id_fkey";

ALTER TABLE "public"."gamedata_signature_validations"
    ALTER COLUMN "validated_at" DROP NOT NULL,
    ALTER COLUMN "validated_at" DROP DEFAULT,
    ADD COLUMN IF NOT EXISTS "started_at" timestamptz,
    ADD COLUMN IF NOT EXISTS "game_server_node_id" text,
    ADD COLUMN IF NOT EXISTS "trigger" text,
    ADD COLUMN IF NOT EXISTS "requested_by_steam_id" bigint,
    ADD COLUMN IF NOT EXISTS "previous_build_id" integer,
    ADD COLUMN IF NOT EXISTS "changes" jsonb;

ALTER TABLE "public"."map_asset_builds"
    ADD COLUMN IF NOT EXISTS "game_server_node_id" text,
    ADD COLUMN IF NOT EXISTS "trigger" text,
    ADD COLUMN IF NOT EXISTS "requested_by_steam_id" bigint,
    ADD COLUMN IF NOT EXISTS "previous_build_id" text,
    ADD COLUMN IF NOT EXISTS "changes" jsonb;

ALTER TABLE "public"."gamedata_signature_validations"
    DROP CONSTRAINT IF EXISTS "gamedata_signature_validations_trigger_check",
    DROP CONSTRAINT IF EXISTS "gamedata_signature_validations_game_server_node_id_fkey",
    DROP CONSTRAINT IF EXISTS "gamedata_signature_validations_requested_by_steam_id_fkey";

ALTER TABLE "public"."gamedata_signature_validations"
    ADD CONSTRAINT "gamedata_signature_validations_trigger_check"
        CHECK ("trigger" IN ('auto', 'manual')),
    ADD CONSTRAINT "gamedata_signature_validations_game_server_node_id_fkey"
        FOREIGN KEY ("game_server_node_id")
        REFERENCES "public"."game_server_nodes" ("id")
        ON UPDATE CASCADE ON DELETE SET NULL,
    ADD CONSTRAINT "gamedata_signature_validations_requested_by_steam_id_fkey"
        FOREIGN KEY ("requested_by_steam_id")
        REFERENCES "public"."players" ("steam_id")
        ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "public"."map_asset_builds"
    DROP CONSTRAINT IF EXISTS "map_asset_builds_trigger_check",
    DROP CONSTRAINT IF EXISTS "map_asset_builds_game_server_node_id_fkey",
    DROP CONSTRAINT IF EXISTS "map_asset_builds_requested_by_steam_id_fkey";

ALTER TABLE "public"."map_asset_builds"
    ADD CONSTRAINT "map_asset_builds_trigger_check"
        CHECK ("trigger" IN ('auto', 'manual')),
    ADD CONSTRAINT "map_asset_builds_game_server_node_id_fkey"
        FOREIGN KEY ("game_server_node_id")
        REFERENCES "public"."game_server_nodes" ("id")
        ON UPDATE CASCADE ON DELETE SET NULL,
    ADD CONSTRAINT "map_asset_builds_requested_by_steam_id_fkey"
        FOREIGN KEY ("requested_by_steam_id")
        REFERENCES "public"."players" ("steam_id")
        ON UPDATE CASCADE ON DELETE SET NULL;
