ALTER TABLE public.game_server_nodes
    ADD COLUMN IF NOT EXISTS update_failed_at timestamptz;
