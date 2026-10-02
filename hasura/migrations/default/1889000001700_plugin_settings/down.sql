DROP TABLE IF EXISTS public.game_plugin_cvars;

ALTER TABLE public.game_plugin_installs
    DROP COLUMN IF EXISTS config;

ALTER TABLE public.game_plugins
    DROP COLUMN IF EXISTS config_cvar,
    DROP COLUMN IF EXISTS config_default,
    DROP COLUMN IF EXISTS config_shipped,
    DROP COLUMN IF EXISTS forced_cvars;
