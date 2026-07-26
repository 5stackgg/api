CREATE TABLE IF NOT EXISTS public.telemetry_installs (
    install_id uuid PRIMARY KEY,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    -- Reported by the install itself, not derived from its address.
    installed_at timestamptz,
    panel_version text,
    schema_version integer,
    country text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_telemetry_installs_last_seen
    ON public.telemetry_installs (last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_installs_first_seen
    ON public.telemetry_installs (first_seen_at DESC);

-- One row per install per day rather than per heartbeat: the hourly beat only
-- needs to keep the day's latest payload, and period totals are read as deltas
-- of the all-time counters so a missed beat cannot double-count.
CREATE TABLE IF NOT EXISTS public.telemetry_snapshots (
    install_id uuid NOT NULL
        REFERENCES public.telemetry_installs(install_id) ON UPDATE CASCADE ON DELETE CASCADE,
    day date NOT NULL,
    reported_at timestamptz NOT NULL DEFAULT now(),
    payload jsonb NOT NULL,
    PRIMARY KEY (install_id, day)
);

CREATE INDEX IF NOT EXISTS idx_telemetry_snapshots_day
    ON public.telemetry_snapshots (day DESC);
