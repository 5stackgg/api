CREATE TABLE IF NOT EXISTS "public"."game_modes" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "slug" text NOT NULL,
    "name" text NOT NULL,
    "description" text,
    "icon" text,
    "enabled" boolean NOT NULL DEFAULT true,
    -- Retiring a mode archives it rather than deleting it: a finished match
    -- keeps naming the mode it was played under.
    "archived_at" timestamptz,
    -- Whether a ranked or matchmaking match may run this mode. Defaults to false
    -- so a newly created mode can never reach ranked play by accident.
    "competitive_safe" boolean NOT NULL DEFAULT false,
    "runtime" text,
    "map_pool_id" uuid,
    "cfg" text,
    "extra_game_params" text,
    "match_option_defaults" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("id"),
    CONSTRAINT "game_modes_slug_key" UNIQUE ("slug"),
    CONSTRAINT "game_modes_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
    CONSTRAINT "game_modes_runtime_fkey" FOREIGN KEY ("runtime")
        REFERENCES "public"."e_plugin_runtimes" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "game_modes_map_pool_fkey" FOREIGN KEY ("map_pool_id")
        REFERENCES "public"."map_pools" ("id") ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "public"."game_mode_plugins" (
    "game_mode_id" uuid NOT NULL,
    "plugin_slug" text NOT NULL,
    "load_order" integer NOT NULL DEFAULT 0,
    "config" jsonb,
    "required" boolean NOT NULL DEFAULT true,
    PRIMARY KEY ("game_mode_id", "plugin_slug"),
    CONSTRAINT "game_mode_plugins_mode_fkey" FOREIGN KEY ("game_mode_id")
        REFERENCES "public"."game_modes" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "game_mode_plugins_plugin_fkey" FOREIGN KEY ("plugin_slug")
        REFERENCES "public"."game_plugins" ("slug") ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS "game_modes_enabled_idx"
    ON "public"."game_modes" ("enabled") WHERE "archived_at" IS NULL;
