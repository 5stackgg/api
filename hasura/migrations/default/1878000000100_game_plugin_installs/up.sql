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

CREATE TABLE IF NOT EXISTS "public"."game_server_node_plugins" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "game_server_node_id" text NOT NULL,
    -- Deliberately not a foreign key to game_plugins: the reconciler records
    -- plugins an admin dropped into custom-plugins by hand, and those have no
    -- registry entry. The Hasura relationship to game_plugins is nullable.
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

CREATE INDEX IF NOT EXISTS "game_server_node_plugins_slug_idx"
    ON "public"."game_server_node_plugins" ("plugin_slug");
