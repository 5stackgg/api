-- Some plugins are not part of a "fun mode" at all -- stats collectors, admin
-- tooling -- and belong on every server including ranked. Without this the only
-- way to get that was to hand-place the files, which is the very thing the
-- catalog replaces.
ALTER TABLE "public"."game_plugin_installs"
    ADD COLUMN IF NOT EXISTS "always_load" boolean NOT NULL DEFAULT false;
