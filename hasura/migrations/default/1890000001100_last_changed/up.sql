-- When an admin last changed a row's settings, and who. Stamped by
-- tbiu_stamp_last_changed (hasura/functions); updated_at keeps its own meaning.
ALTER TABLE public.servers
    ADD COLUMN IF NOT EXISTS last_changed_at timestamptz NULL,
    ADD COLUMN IF NOT EXISTS last_changed_by_steam_id bigint NULL
        REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE public.game_server_nodes
    ADD COLUMN IF NOT EXISTS last_changed_at timestamptz NULL,
    ADD COLUMN IF NOT EXISTS last_changed_by_steam_id bigint NULL
        REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE public.seasons
    ADD COLUMN IF NOT EXISTS last_changed_at timestamptz NULL,
    ADD COLUMN IF NOT EXISTS last_changed_by_steam_id bigint NULL
        REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE public.server_regions
    ADD COLUMN IF NOT EXISTS last_changed_at timestamptz NULL,
    ADD COLUMN IF NOT EXISTS last_changed_by_steam_id bigint NULL
        REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE public.system_alerts
    ADD COLUMN IF NOT EXISTS last_changed_at timestamptz NULL,
    ADD COLUMN IF NOT EXISTS last_changed_by_steam_id bigint NULL
        REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE public.awards
    ADD COLUMN IF NOT EXISTS last_changed_at timestamptz NULL,
    ADD COLUMN IF NOT EXISTS last_changed_by_steam_id bigint NULL
        REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE SET NULL;
