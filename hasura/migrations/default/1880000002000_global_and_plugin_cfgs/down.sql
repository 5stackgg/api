ALTER TABLE "public"."game_plugin_installs"
    ADD COLUMN IF NOT EXISTS "always_load" boolean NOT NULL DEFAULT false;

-- always_load reached ranked, so only a plugin already allowed on ranked may
-- come back as always_load. Collapsing the union instead would silently put a
-- plugin the operator kept off ranked onto ranked servers on rollback.
UPDATE "public"."game_plugin_installs"
   SET "always_load" = true
 WHERE "load_ranked";

ALTER TABLE "public"."game_plugin_installs"
    DROP COLUMN IF EXISTS "cfg",
    DROP COLUMN IF EXISTS "load_ranked",
    DROP COLUMN IF EXISTS "load_tournaments",
    DROP COLUMN IF EXISTS "load_custom";

DELETE FROM "public"."match_type_cfgs" WHERE "type" = 'Global';
