-- The node's GPU vendor, written by the api from each ping: 'nvidia', 'amd',
-- or NULL for a node without a GPU. No default and no backfill, so adding it
-- rewrites no row and fires no row trigger.
ALTER TABLE public.game_server_nodes
    ADD COLUMN IF NOT EXISTS gpu_vendor text NULL
        CONSTRAINT game_server_nodes_gpu_vendor_check
        CHECK (gpu_vendor IN ('nvidia', 'amd'));
