-- A cvar block that applies to every match, and one per installed game plugin.
-- The 'Global' e_game_cfg_types value is seeded from hasura/enums/maps.sql,
-- which is re-applied on every boot -- enum rows are not a migration's to own.

-- The plugin's own cvars, exec'd only on servers that load it. Global is
-- deliberately unscoped: it is the operator's "every match" layer, and a
-- global with exceptions is just a type config with extra steps.
ALTER TABLE "public"."game_plugin_installs"
    ADD COLUMN IF NOT EXISTS "cfg" text,
    -- Which kinds of match load this plugin without a game mode asking for it.
    -- This replaces the single always_load flag, which could only say "every
    -- match, ranked included" -- and ranked is the one an operator most often
    -- wants to leave out. Default off: installing a plugin is not consent to
    -- run it on every server, and a game mode that names it still loads it.
    ADD COLUMN IF NOT EXISTS "load_ranked" boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "load_tournaments" boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "load_custom" boolean NOT NULL DEFAULT false;

-- always_load meant all three, so that is what it becomes.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'game_plugin_installs'
           AND column_name = 'always_load'
    ) THEN
        UPDATE "public"."game_plugin_installs"
           SET "load_ranked" = true,
               "load_tournaments" = true,
               "load_custom" = true
         WHERE "always_load" = true;
    END IF;
END $$;

ALTER TABLE "public"."game_plugin_installs"
    DROP COLUMN IF EXISTS "always_load";
