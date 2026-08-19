ALTER TABLE "public"."game_modes"
    ADD COLUMN IF NOT EXISTS "runtime" text;

ALTER TABLE "public"."game_modes"
    ADD CONSTRAINT "game_modes_runtime_fkey" FOREIGN KEY ("runtime")
        REFERENCES "public"."e_plugin_runtimes" ("value") ON UPDATE CASCADE ON DELETE RESTRICT;
