ALTER TABLE public.servers
    DROP COLUMN IF EXISTS last_changed_by_steam_id,
    DROP COLUMN IF EXISTS last_changed_at;

ALTER TABLE public.game_server_nodes
    DROP COLUMN IF EXISTS last_changed_by_steam_id,
    DROP COLUMN IF EXISTS last_changed_at;

ALTER TABLE public.seasons
    DROP COLUMN IF EXISTS last_changed_by_steam_id,
    DROP COLUMN IF EXISTS last_changed_at;

ALTER TABLE public.server_regions
    DROP COLUMN IF EXISTS last_changed_by_steam_id,
    DROP COLUMN IF EXISTS last_changed_at;

ALTER TABLE public.system_alerts
    DROP COLUMN IF EXISTS last_changed_by_steam_id,
    DROP COLUMN IF EXISTS last_changed_at;

ALTER TABLE public.awards
    DROP COLUMN IF EXISTS last_changed_by_steam_id,
    DROP COLUMN IF EXISTS last_changed_at;
