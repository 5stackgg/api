-- CS:GO gets its own update status and failure time instead of sharing CS2's,
-- and each game keeps the last lines of a failed update's log.
ALTER TABLE public.game_server_nodes
    ADD COLUMN IF NOT EXISTS csgo_update_status text NULL,
    ADD COLUMN IF NOT EXISTS csgo_update_failed_at timestamptz NULL,
    ADD COLUMN IF NOT EXISTS update_error text NULL,
    ADD COLUMN IF NOT EXISTS csgo_update_error text NULL;
