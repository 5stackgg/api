ALTER TABLE public.servers
    ADD COLUMN IF NOT EXISTS map_rotation_shuffle boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS public.server_map_rotation (
    server_id uuid NOT NULL,
    map_id uuid NOT NULL,
    position integer NOT NULL,
    PRIMARY KEY (server_id, map_id),
    CONSTRAINT server_map_rotation_server_fkey FOREIGN KEY (server_id)
        REFERENCES public.servers (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT server_map_rotation_map_fkey FOREIGN KEY (map_id)
        REFERENCES public.maps (id) ON UPDATE CASCADE ON DELETE CASCADE
);

-- No row means the plugin follows its install's load flags on this server.
CREATE TABLE IF NOT EXISTS public.server_plugins (
    server_id uuid NOT NULL,
    plugin_slug text NOT NULL,
    enabled boolean NOT NULL,
    PRIMARY KEY (server_id, plugin_slug),
    CONSTRAINT server_plugins_server_fkey FOREIGN KEY (server_id)
        REFERENCES public.servers (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT server_plugins_install_fkey FOREIGN KEY (plugin_slug)
        REFERENCES public.game_plugin_installs (plugin_slug) ON UPDATE CASCADE ON DELETE CASCADE
);

ALTER TABLE public.game_plugins
    ADD COLUMN IF NOT EXISTS map_rotation jsonb;
