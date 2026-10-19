ALTER TABLE public.game_server_nodes
    DROP COLUMN IF EXISTS csgo_update_status,
    DROP COLUMN IF EXISTS csgo_update_failed_at,
    DROP COLUMN IF EXISTS update_error,
    DROP COLUMN IF EXISTS csgo_update_error;
