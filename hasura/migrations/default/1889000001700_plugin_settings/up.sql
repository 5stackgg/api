ALTER TABLE public.game_plugins
    ADD COLUMN IF NOT EXISTS config_cvar text,
    ADD COLUMN IF NOT EXISTS config_default jsonb,
    ADD COLUMN IF NOT EXISTS config_shipped jsonb,
    ADD COLUMN IF NOT EXISTS forced_cvars text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.game_plugin_installs
    ADD COLUMN IF NOT EXISTS config jsonb;

-- One row per cvar the catalog lists, as a server running the plugin reported
-- it. default_value is only ever read from a server where none of the panel's
-- configs set that cvar, so it stays NULL until such a server reports.
CREATE TABLE IF NOT EXISTS public.game_plugin_cvars (
    plugin_slug text NOT NULL,
    name text NOT NULL,
    runtime text NOT NULL,
    version text NOT NULL,
    kind text NOT NULL,
    default_value text,
    description text NOT NULL DEFAULT '',
    flags text NOT NULL DEFAULT '',
    reported_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (plugin_slug, name),
    CONSTRAINT game_plugin_cvars_plugin_slug_fkey FOREIGN KEY (plugin_slug)
        REFERENCES public.game_plugins (slug) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT game_plugin_cvars_kind_check
        CHECK (kind IN ('bool', 'int', 'float', 'string'))
);
