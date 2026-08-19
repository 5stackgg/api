ALTER TABLE "public"."match_options"
    ADD COLUMN IF NOT EXISTS "game_mode_id" uuid;

ALTER TABLE "public"."match_options"
    ADD CONSTRAINT "match_options_game_mode_fkey" FOREIGN KEY ("game_mode_id")
        REFERENCES "public"."game_modes" ("id") ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS "match_options_game_mode_idx"
    ON "public"."match_options" ("game_mode_id") WHERE "game_mode_id" IS NOT NULL;
