ALTER TABLE "public"."map_asset_builds"
    DROP CONSTRAINT IF EXISTS "map_asset_builds_trigger_check",
    DROP CONSTRAINT IF EXISTS "map_asset_builds_game_server_node_id_fkey",
    DROP CONSTRAINT IF EXISTS "map_asset_builds_requested_by_steam_id_fkey",
    DROP COLUMN IF EXISTS "game_server_node_id",
    DROP COLUMN IF EXISTS "trigger",
    DROP COLUMN IF EXISTS "requested_by_steam_id",
    DROP COLUMN IF EXISTS "previous_build_id",
    DROP COLUMN IF EXISTS "changes";

ALTER TABLE "public"."gamedata_signature_validations"
    DROP CONSTRAINT IF EXISTS "gamedata_signature_validations_trigger_check",
    DROP CONSTRAINT IF EXISTS "gamedata_signature_validations_game_server_node_id_fkey",
    DROP CONSTRAINT IF EXISTS "gamedata_signature_validations_requested_by_steam_id_fkey",
    DROP COLUMN IF EXISTS "started_at",
    DROP COLUMN IF EXISTS "game_server_node_id",
    DROP COLUMN IF EXISTS "trigger",
    DROP COLUMN IF EXISTS "requested_by_steam_id",
    DROP COLUMN IF EXISTS "previous_build_id",
    DROP COLUMN IF EXISTS "changes";

UPDATE "public"."gamedata_signature_validations"
   SET "validated_at" = now()
 WHERE "validated_at" IS NULL;

ALTER TABLE "public"."gamedata_signature_validations"
    ALTER COLUMN "validated_at" SET DEFAULT now(),
    ALTER COLUMN "validated_at" SET NOT NULL;

DELETE FROM "public"."gamedata_signature_validations"
 WHERE "build_id" NOT IN (SELECT "build_id" FROM "public"."game_versions");

ALTER TABLE "public"."gamedata_signature_validations"
    DROP CONSTRAINT IF EXISTS "gamedata_signature_validations_build_id_fkey";

ALTER TABLE "public"."gamedata_signature_validations"
    ADD CONSTRAINT "gamedata_signature_validations_build_id_fkey"
    FOREIGN KEY ("build_id")
    REFERENCES "public"."game_versions" ("build_id")
    ON UPDATE CASCADE
    ON DELETE CASCADE;
