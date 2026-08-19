ALTER TABLE "public"."game_modes"
    ADD COLUMN IF NOT EXISTS "map_pool_id" uuid;

ALTER TABLE "public"."game_modes"
    ADD COLUMN IF NOT EXISTS "match_option_defaults" jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "public"."game_modes"
    DROP CONSTRAINT IF EXISTS "game_modes_map_pool_fkey";

ALTER TABLE "public"."game_modes"
    ADD CONSTRAINT "game_modes_map_pool_fkey" FOREIGN KEY ("map_pool_id")
        REFERENCES "public"."map_pools" ("id") ON UPDATE CASCADE ON DELETE SET NULL;
