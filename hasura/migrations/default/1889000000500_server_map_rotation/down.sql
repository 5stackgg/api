ALTER TABLE public.game_plugins
    DROP COLUMN IF EXISTS map_rotation;

DROP TABLE IF EXISTS public.server_plugins;

DROP TABLE IF EXISTS public.server_map_rotation;

ALTER TABLE public.servers
    DROP COLUMN IF EXISTS map_rotation_shuffle;
