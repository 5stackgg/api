-- A plugin's cvars and config file set for one community server, layered over
-- what the plugin's own page sets for every server that loads it.
CREATE TABLE IF NOT EXISTS public.server_plugin_configs (
    server_id uuid NOT NULL,
    plugin_slug text NOT NULL,
    cfg text,
    config jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, plugin_slug),
    CONSTRAINT server_plugin_configs_server_fkey FOREIGN KEY (server_id)
        REFERENCES public.servers (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT server_plugin_configs_plugin_fkey FOREIGN KEY (plugin_slug)
        REFERENCES public.game_plugins (slug) ON UPDATE CASCADE ON DELETE CASCADE
);
