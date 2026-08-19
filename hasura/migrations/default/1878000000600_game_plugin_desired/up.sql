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

-- Nodes report what they converged to, so a node that has never checked in is
-- distinguishable from one that checked in with nothing.
ALTER TABLE "public"."game_server_nodes"
    ADD COLUMN IF NOT EXISTS "plugins_synced_at" timestamptz;
