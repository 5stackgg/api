ALTER TABLE public.servers
    ADD COLUMN IF NOT EXISTS player_management_version text,
    ADD COLUMN IF NOT EXISTS player_management_runtime text,
    ADD COLUMN IF NOT EXISTS player_management_seen_at timestamptz;
