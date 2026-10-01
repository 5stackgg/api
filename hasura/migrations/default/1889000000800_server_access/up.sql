ALTER TABLE public.servers
    ADD COLUMN IF NOT EXISTS access_restricted boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS access_min_role text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'servers_access_min_role_fkey'
    ) THEN
        ALTER TABLE public.servers
            ADD CONSTRAINT servers_access_min_role_fkey FOREIGN KEY (access_min_role)
                REFERENCES public.e_player_roles (value) ON UPDATE CASCADE ON DELETE SET NULL;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.server_access_players (
    server_id uuid NOT NULL,
    steam_id bigint NOT NULL,
    PRIMARY KEY (server_id, steam_id),
    CONSTRAINT server_access_players_server_fkey FOREIGN KEY (server_id)
        REFERENCES public.servers (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT server_access_players_player_fkey FOREIGN KEY (steam_id)
        REFERENCES public.players (steam_id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.server_access_events (
    server_id uuid NOT NULL,
    event_id uuid NOT NULL,
    PRIMARY KEY (server_id, event_id),
    CONSTRAINT server_access_events_server_fkey FOREIGN KEY (server_id)
        REFERENCES public.servers (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT server_access_events_event_fkey FOREIGN KEY (event_id)
        REFERENCES public.events (id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS server_access_events_event_idx
    ON public.server_access_events (event_id);
