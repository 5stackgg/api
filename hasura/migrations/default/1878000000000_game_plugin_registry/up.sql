CREATE TABLE IF NOT EXISTS "public"."e_game_plugin_kinds" (
    "value" text NOT NULL,
    "description" text NOT NULL,
    PRIMARY KEY ("value")
);

CREATE TABLE IF NOT EXISTS "public"."game_plugins" (
    "slug" text NOT NULL,
    "kind" text NOT NULL,
    "name" text NOT NULL,
    "author" text NOT NULL,
    "description" text NOT NULL,
    "homepage" text,
    "tags" text[] NOT NULL DEFAULT '{}',
    "verified" boolean NOT NULL DEFAULT false,
    "hot_swappable" boolean NOT NULL DEFAULT false,
    "requires_service" text,
    "config_schema" jsonb,
    "config_path" text,
    "cvars" text[] NOT NULL DEFAULT '{}',
    "panel" jsonb,
    "wiring" jsonb,
    "synced_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("slug"),
    CONSTRAINT "game_plugins_kind_fkey" FOREIGN KEY ("kind")
        REFERENCES "public"."e_game_plugin_kinds" ("value") ON UPDATE CASCADE ON DELETE RESTRICT
);

-- The slug is also the directory name in a node's plugin store, so a value that
-- is not path-safe would let a registry entry escape the store root.
ALTER TABLE "public"."game_plugins"
    ADD CONSTRAINT "game_plugins_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');

CREATE TABLE IF NOT EXISTS "public"."game_plugin_versions" (
    "plugin_slug" text NOT NULL,
    "runtime" text NOT NULL,
    "version" text NOT NULL,
    "url" text NOT NULL,
    "sha256" text NOT NULL,
    "size" integer,
    "published_at" timestamptz NOT NULL,
    "prerelease" boolean NOT NULL DEFAULT false,
    "layout" text NOT NULL DEFAULT 'csgo',
    "install_path" text,
    PRIMARY KEY ("plugin_slug", "runtime", "version"),
    CONSTRAINT "game_plugin_versions_plugin_slug_fkey" FOREIGN KEY ("plugin_slug")
        REFERENCES "public"."game_plugins" ("slug") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "game_plugin_versions_runtime_fkey" FOREIGN KEY ("runtime")
        REFERENCES "public"."e_plugin_runtimes" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "game_plugin_versions_sha256_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "game_plugin_versions_layout_check" CHECK ("layout" IN ('csgo', 'plugin'))
);

CREATE INDEX IF NOT EXISTS "game_plugin_versions_runtime_published_idx"
    ON "public"."game_plugin_versions" ("runtime", "published_at" DESC);

CREATE INDEX IF NOT EXISTS "game_plugins_kind_verified_idx"
    ON "public"."game_plugins" ("kind", "verified");
