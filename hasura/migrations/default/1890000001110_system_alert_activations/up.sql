-- One row per period a system alert was showing. taiu_system_alert_activations
-- (hasura/functions) opens and closes them as is_active flips.
CREATE TABLE IF NOT EXISTS public.system_alert_activations (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    alert_id uuid NOT NULL
        REFERENCES public.system_alerts(id) ON DELETE CASCADE,
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz NULL,
    started_by_steam_id bigint NULL
        REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE SET NULL,
    ended_by_steam_id bigint NULL
        REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE SET NULL,
    estimated boolean NOT NULL DEFAULT false,
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS system_alert_activations_alert_id_started_at_idx
    ON public.system_alert_activations (alert_id, started_at);

-- A timeline window reads the periods that overlap it:
-- (ended_at IS NULL OR ended_at > window start) AND started_at < window end.
CREATE INDEX IF NOT EXISTS system_alert_activations_ended_at_started_at_idx
    ON public.system_alert_activations (ended_at, started_at);

CREATE UNIQUE INDEX IF NOT EXISTS system_alert_activations_one_open_idx
    ON public.system_alert_activations (alert_id)
    WHERE ended_at IS NULL;

-- Until now updated_at was written when an alert went up or came down, so a
-- live alert went up at its updated_at. An alert that is off kept no record of
-- when it went up; created_at -> updated_at is the span the page drew for it,
-- kept and flagged as a guess.
INSERT INTO public.system_alert_activations (alert_id, started_at)
SELECT id, updated_at
  FROM public.system_alerts
 WHERE is_active;

INSERT INTO public.system_alert_activations (alert_id, started_at, ended_at, estimated)
SELECT id, created_at, updated_at, true
  FROM public.system_alerts
 WHERE NOT is_active
   AND updated_at > created_at;
