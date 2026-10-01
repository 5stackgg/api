CREATE TABLE IF NOT EXISTS public.server_rosters (
    server_id uuid PRIMARY KEY,
    reported_at timestamptz NOT NULL,
    held_since timestamptz,
    CONSTRAINT server_rosters_server_fkey FOREIGN KEY (server_id)
        REFERENCES public.servers (id) ON UPDATE CASCADE ON DELETE CASCADE
) WITH (fillfactor = 50);

CREATE TABLE IF NOT EXISTS public.server_player_sessions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    server_id uuid NOT NULL,
    player_steam_id bigint NOT NULL,
    conn text,
    settled_conns text[] NOT NULL DEFAULT '{}',
    name text,
    ip inet,
    kills integer NOT NULL DEFAULT 0,
    deaths integer NOT NULL DEFAULT 0,
    kills_conn integer NOT NULL DEFAULT 0,
    deaths_conn integer NOT NULL DEFAULT 0,
    started_at timestamptz NOT NULL,
    ended_at timestamptz,
    CONSTRAINT server_player_sessions_server_fkey FOREIGN KEY (server_id)
        REFERENCES public.servers (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT server_player_sessions_name_length CHECK (char_length(name) <= 128),
    CONSTRAINT server_player_sessions_ended_after_start
        CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS server_player_sessions_open_idx
    ON public.server_player_sessions (server_id, player_steam_id)
    WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS server_player_sessions_server_player_idx
    ON public.server_player_sessions (server_id, player_steam_id, ended_at);

CREATE INDEX IF NOT EXISTS server_player_sessions_player_idx
    ON public.server_player_sessions (player_steam_id, started_at DESC);

CREATE INDEX IF NOT EXISTS server_player_sessions_ended_idx
    ON public.server_player_sessions (ended_at)
    WHERE ended_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS server_player_sessions_ip_idx
    ON public.server_player_sessions (ip)
    WHERE ip IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.server_player_stats (
    server_id uuid NOT NULL,
    player_steam_id bigint NOT NULL,
    sessions integer NOT NULL DEFAULT 0,
    seconds_played bigint NOT NULL DEFAULT 0,
    kills integer NOT NULL DEFAULT 0,
    deaths integer NOT NULL DEFAULT 0,
    first_seen_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    PRIMARY KEY (server_id, player_steam_id),
    CONSTRAINT server_player_stats_server_fkey FOREIGN KEY (server_id)
        REFERENCES public.servers (id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS server_player_stats_player_idx
    ON public.server_player_stats (player_steam_id);

INSERT INTO public.settings (name, value)
VALUES ('player_session_retention_days', '7')
ON CONFLICT (name) DO NOTHING;
