ALTER TABLE public.game_server_nodes
  ADD COLUMN IF NOT EXISTS cpu_warnings jsonb;
