-- A mode does not get to declare which framework it runs on. That is decided by
-- the plugins it selects: a mode is runnable on a runtime only if every plugin
-- in it publishes a build for that runtime. Picking it by hand could disagree
-- with the plugins and silently boot a server with none of them.
ALTER TABLE "public"."game_modes"
    DROP CONSTRAINT IF EXISTS "game_modes_runtime_fkey";

ALTER TABLE "public"."game_modes"
    DROP COLUMN IF EXISTS "runtime";
