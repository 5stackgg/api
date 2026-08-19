ALTER TABLE "public"."servers"
    ADD COLUMN IF NOT EXISTS "game_mode_id" uuid;

ALTER TABLE "public"."servers"
    ADD CONSTRAINT "servers_game_mode_fkey" FOREIGN KEY ("game_mode_id")
        REFERENCES "public"."game_modes" ("id") ON UPDATE CASCADE ON DELETE SET NULL;

-- A Ranked server is matchmaking capacity. It never inherits a persistent mode
-- (a fun match has to ask for one on the match itself), so storing one here
-- could only ever mislead whoever set it.
ALTER TABLE "public"."servers"
    ADD CONSTRAINT "servers_ranked_has_no_game_mode_check"
        CHECK ("type" IS DISTINCT FROM 'Ranked' OR "game_mode_id" IS NULL);

ALTER TABLE "public"."custom_pages"
    ADD COLUMN IF NOT EXISTS "plugin_slug" text;

CREATE UNIQUE INDEX IF NOT EXISTS "custom_pages_plugin_slug_idx"
    ON "public"."custom_pages" ("plugin_slug") WHERE "plugin_slug" IS NOT NULL;
