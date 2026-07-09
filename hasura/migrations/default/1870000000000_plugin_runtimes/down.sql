DROP FUNCTION IF EXISTS public.game_version_supports_plugin(integer, text, text);
DROP FUNCTION IF EXISTS public.active_plugin_runtime();

ALTER TABLE public.servers
  DROP CONSTRAINT IF EXISTS "servers_plugin_runtime_fkey";

ALTER TABLE public.servers
  DROP COLUMN IF EXISTS "plugin_runtime";

ALTER TABLE public.game_server_nodes
  DROP CONSTRAINT IF EXISTS "game_server_nodes_pin_plugin_version_fkey";

ALTER TABLE public.game_server_nodes
  DROP CONSTRAINT IF EXISTS "game_server_nodes_pin_plugin_version_check";

-- these pins survive the DELETE below and then fail the single-column foreign key
-- when it is re-added
UPDATE public.game_server_nodes
  SET "pin_plugin_version" = NULL
  WHERE "pin_plugin_version" IS NOT NULL
    AND "pin_plugin_runtime" IS DISTINCT FROM 'counterstrikesharp';

ALTER TABLE public.game_server_nodes
  DROP COLUMN IF EXISTS "pin_plugin_runtime";

ALTER TABLE public.plugin_versions
  DROP CONSTRAINT IF EXISTS "plugin_versions_runtime_fkey";

ALTER TABLE public.plugin_versions
  DROP CONSTRAINT IF EXISTS "plugin_versions_pkey";

-- Collapsing back to a single lineage: keep only the CounterStrikeSharp rows,
-- which is what the pre-migration release feed produced.
DELETE FROM public.plugin_versions WHERE "runtime" <> 'counterstrikesharp';

ALTER TABLE public.plugin_versions
  DROP COLUMN IF EXISTS "runtime";

ALTER TABLE public.plugin_versions
  ADD CONSTRAINT "plugin_versions_pkey" PRIMARY KEY ("version");

ALTER TABLE public.game_server_nodes
  ADD CONSTRAINT "game_server_nodes_pin_plugin_version_fkey"
  FOREIGN KEY ("pin_plugin_version")
  REFERENCES public.plugin_versions ("version")
  ON UPDATE CASCADE ON DELETE SET NULL;

DROP TABLE IF EXISTS public.e_plugin_runtimes;
