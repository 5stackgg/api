DROP TABLE IF EXISTS public.server_access_events;

DROP TABLE IF EXISTS public.server_access_players;

ALTER TABLE public.servers
    DROP CONSTRAINT IF EXISTS servers_access_min_role_fkey,
    DROP COLUMN IF EXISTS access_min_role,
    DROP COLUMN IF EXISTS access_restricted;
