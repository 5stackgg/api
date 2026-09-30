ALTER TABLE public.servers
    DROP COLUMN IF EXISTS player_management_seen_at,
    DROP COLUMN IF EXISTS player_management_runtime,
    DROP COLUMN IF EXISTS player_management_version;
