-- Slugs of catalog entries an entry works with. A panel plugin that configures a
-- game plugin points at it here instead of republishing its releases, which
-- would list the same download twice under two names.
ALTER TABLE "public"."game_plugins"
    ADD COLUMN IF NOT EXISTS "pairs_with" text[] NOT NULL DEFAULT '{}';
