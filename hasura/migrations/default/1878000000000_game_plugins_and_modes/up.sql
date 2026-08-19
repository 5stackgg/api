-- Game plugin catalog, per-node installs, and game modes.

CREATE TABLE IF NOT EXISTS "public"."e_game_plugin_kinds" (
    "value" text NOT NULL,
    "description" text NOT NULL,
    PRIMARY KEY ("value")
);

CREATE TABLE IF NOT EXISTS "public"."e_game_plugin_install_statuses" (
    "value" text NOT NULL,
    "description" text NOT NULL,
    PRIMARY KEY ("value")
);

CREATE TABLE IF NOT EXISTS "public"."e_game_plugin_channels" (
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
    -- Slugs of catalog entries this one works with. A panel plugin that
    -- configures a game plugin points at it here instead of republishing its
    -- releases, which would list the same download twice under two names.
    "pairs_with" text[] NOT NULL DEFAULT '{}',
    "synced_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("slug"),
    -- The slug also names a directory inside the node's plugin directory, so a
    -- value that is not path-safe would let a registry entry escape it.
    CONSTRAINT "game_plugins_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
    CONSTRAINT "game_plugins_kind_fkey" FOREIGN KEY ("kind")
        REFERENCES "public"."e_game_plugin_kinds" ("value") ON UPDATE CASCADE ON DELETE RESTRICT
);

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

-- What the operator wants installed, deployment-wide. Separate from
-- game_server_node_plugins, which records what a node actually has: conflating
-- the two is why installing was a one-shot loop that missed any node offline at
-- the time and never reached a node that joined later.
CREATE TABLE IF NOT EXISTS "public"."game_plugin_installs" (
    "plugin_slug" text NOT NULL,
    -- Null means track the newest release; a value pins it.
    "version" text,
    "channel" text NOT NULL DEFAULT 'Pinned',
    "enabled" boolean NOT NULL DEFAULT true,
    -- Some plugins are not part of a "fun mode" at all -- stats collectors,
    -- admin tooling -- and belong on every server including ranked.
    "always_load" boolean NOT NULL DEFAULT false,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("plugin_slug"),
    CONSTRAINT "game_plugin_installs_plugin_fkey" FOREIGN KEY ("plugin_slug")
        REFERENCES "public"."game_plugins" ("slug") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "game_plugin_installs_channel_fkey" FOREIGN KEY ("channel")
        REFERENCES "public"."e_game_plugin_channels" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    -- A pinned row with no version has nothing to pin to, and an Auto row with
    -- one would have its version overwritten on the next release.
    CONSTRAINT "game_plugin_installs_channel_version_check"
        CHECK (("channel" = 'Auto') = ("version" IS NULL))
);

CREATE TABLE IF NOT EXISTS "public"."game_server_node_plugins" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "game_server_node_id" text NOT NULL,
    -- Deliberately not a foreign key to game_plugins: the reconciler records
    -- plugins an admin dropped in by hand, and those have no registry entry.
    -- The Hasura relationship to game_plugins is nullable.
    "plugin_slug" text NOT NULL,
    "runtime" text NOT NULL,
    "version" text,
    "detected_version" text,
    "channel" text NOT NULL DEFAULT 'Pinned',
    "status" text NOT NULL DEFAULT 'Pending',
    "source" text NOT NULL DEFAULT 'managed',
    "detected" boolean NOT NULL DEFAULT false,
    "last_error" text,
    "installed_at" timestamptz,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("id"),
    CONSTRAINT "game_server_node_plugins_node_plugin_key"
        UNIQUE ("game_server_node_id", "plugin_slug"),
    CONSTRAINT "game_server_node_plugins_node_fkey" FOREIGN KEY ("game_server_node_id")
        REFERENCES "public"."game_server_nodes" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "game_server_node_plugins_runtime_fkey" FOREIGN KEY ("runtime")
        REFERENCES "public"."e_plugin_runtimes" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "game_server_node_plugins_channel_fkey" FOREIGN KEY ("channel")
        REFERENCES "public"."e_game_plugin_channels" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "game_server_node_plugins_status_fkey" FOREIGN KEY ("status")
        REFERENCES "public"."e_game_plugin_install_statuses" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "game_server_node_plugins_source_check" CHECK ("source" IN ('managed', 'manual'))
);

-- A mode does not declare which framework it runs on. That is derived from the
-- plugins it selects: a mode is runnable on a runtime only if every plugin in
-- it publishes a build for that runtime.
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
    -- Whether a ranked or matchmaking match may run this mode. Defaults to
    -- false so a newly created mode can never reach ranked play by accident.
    "competitive_safe" boolean NOT NULL DEFAULT false,
    "cfg" text,
    "extra_game_params" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("id"),
    CONSTRAINT "game_modes_slug_key" UNIQUE ("slug"),
    CONSTRAINT "game_modes_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
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

ALTER TABLE "public"."match_options"
    ADD COLUMN IF NOT EXISTS "game_mode_id" uuid;

ALTER TABLE "public"."match_options"
    ADD CONSTRAINT "match_options_game_mode_fkey" FOREIGN KEY ("game_mode_id")
        REFERENCES "public"."game_modes" ("id") ON UPDATE CASCADE ON DELETE RESTRICT;

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

-- What the server reported actually loaded, as opposed to what is on disk.
-- Files being present is not the same as a plugin loading: a CS2 update breaks
-- signatures, a build targets the other framework, a config is malformed. All
-- of those look identical on the filesystem and only differ here.
ALTER TABLE "public"."servers"
    ADD COLUMN IF NOT EXISTS "loaded_plugins" jsonb;

ALTER TABLE "public"."servers"
    ADD COLUMN IF NOT EXISTS "plugins_checked_at" timestamptz;

ALTER TABLE "public"."custom_pages"
    ADD COLUMN IF NOT EXISTS "plugin_slug" text;

-- Nodes report what they converged to, so a node that has never checked in is
-- distinguishable from one that checked in with nothing.
ALTER TABLE "public"."game_server_nodes"
    ADD COLUMN IF NOT EXISTS "plugins_synced_at" timestamptz;

-- Whether this match moves ELO and appears on stats leaderboards.
--
-- Stored on the match rather than derived from its game mode at ELO time, so
-- the decision is frozen the moment the match is created. Deriving it would
-- mean flipping a mode's competitive_safe flag silently rewrote whether matches
-- played months ago had counted.
--
-- Defaults true, so every match that already exists keeps counting.
ALTER TABLE "public"."matches"
    ADD COLUMN IF NOT EXISTS "counts_toward_ranking" boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS "game_plugin_versions_runtime_published_idx"
    ON "public"."game_plugin_versions" ("runtime", "published_at" DESC);

CREATE INDEX IF NOT EXISTS "game_plugins_kind_verified_idx"
    ON "public"."game_plugins" ("kind", "verified");

CREATE INDEX IF NOT EXISTS "game_server_node_plugins_slug_idx"
    ON "public"."game_server_node_plugins" ("plugin_slug");

CREATE INDEX IF NOT EXISTS "game_modes_enabled_idx"
    ON "public"."game_modes" ("enabled") WHERE "archived_at" IS NULL;

CREATE INDEX IF NOT EXISTS "match_options_game_mode_idx"
    ON "public"."match_options" ("game_mode_id") WHERE "game_mode_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "custom_pages_plugin_slug_idx"
    ON "public"."custom_pages" ("plugin_slug") WHERE "plugin_slug" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "matches_counts_toward_ranking_idx"
    ON "public"."matches" ("counts_toward_ranking")
    WHERE "counts_toward_ranking" = false;
