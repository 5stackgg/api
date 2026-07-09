CREATE TABLE IF NOT EXISTS public.e_plugin_runtimes (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);

INSERT INTO e_plugin_runtimes ("value", "description") VALUES
    ('swiftlys2', 'Plugin loads under the SwiftlyS2 framework'),
    ('counterstrikesharp', 'Plugin loads under Metamod and CounterStrikeSharp')
ON CONFLICT(value) DO UPDATE SET "description" = EXCLUDED."description";

-- Every row already in plugin_versions was ingested from the CounterStrikeSharp
-- plugin repo, which was the only release feed before this migration.
ALTER TABLE public.plugin_versions
  ADD COLUMN IF NOT EXISTS "runtime" text NOT NULL DEFAULT 'counterstrikesharp';

ALTER TABLE public.plugin_versions
  ALTER COLUMN "runtime" DROP DEFAULT;

ALTER TABLE public.game_server_nodes
  DROP CONSTRAINT IF EXISTS "game_server_nodes_pin_plugin_version_fkey";

-- Both plugin repos mint tags from their own counter, so v0.0.42 exists in each.
-- The version alone can no longer identify a release.
ALTER TABLE public.plugin_versions
  DROP CONSTRAINT IF EXISTS "plugin_versions_pkey";

ALTER TABLE public.plugin_versions
  ADD CONSTRAINT "plugin_versions_pkey" PRIMARY KEY ("runtime", "version");

ALTER TABLE public.plugin_versions
  ADD CONSTRAINT "plugin_versions_runtime_fkey"
  FOREIGN KEY ("runtime")
  REFERENCES public.e_plugin_runtimes ("value")
  ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE public.game_server_nodes
  ADD COLUMN IF NOT EXISTS "pin_plugin_runtime" text NULL;

UPDATE public.game_server_nodes
  SET "pin_plugin_runtime" = 'counterstrikesharp'
  WHERE "pin_plugin_version" IS NOT NULL
    AND "pin_plugin_runtime" IS NULL;

ALTER TABLE public.game_server_nodes
  ADD CONSTRAINT "game_server_nodes_pin_plugin_version_check"
  CHECK (("pin_plugin_runtime" IS NULL) = ("pin_plugin_version" IS NULL));

ALTER TABLE public.game_server_nodes
  ADD CONSTRAINT "game_server_nodes_pin_plugin_version_fkey"
  FOREIGN KEY ("pin_plugin_runtime", "pin_plugin_version")
  REFERENCES public.plugin_versions ("runtime", "version")
  ON UPDATE CASCADE ON DELETE SET NULL;

-- game_version_supports_plugin gains a runtime argument. Adding a parameter makes
-- `create or replace` mint an overload rather than replace, so the old signature
-- has to go before hasura/functions is re-applied on boot.
DROP FUNCTION IF EXISTS public.game_version_supports_plugin(integer, text);

ALTER TABLE public.servers
  ADD COLUMN IF NOT EXISTS "plugin_runtime" text NULL;

ALTER TABLE public.servers
  ADD CONSTRAINT "servers_plugin_runtime_fkey"
  FOREIGN KEY ("plugin_runtime")
  REFERENCES public.e_plugin_runtimes ("value")
  ON UPDATE CASCADE ON DELETE SET NULL;
