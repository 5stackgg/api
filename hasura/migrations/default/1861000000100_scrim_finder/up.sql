CREATE TABLE IF NOT EXISTS public.e_scrim_request_statuses (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);

INSERT INTO public.e_scrim_request_statuses ("value", "description") VALUES
    ('Pending', 'Awaiting the other team to accept, decline, or counter'),
    ('Countered', 'A new time was proposed and is awaiting the other team'),
    ('Accepted', 'Both teams agreed on a time'),
    ('Declined', 'The request was declined'),
    ('Expired', 'The request expired before being answered'),
    ('Cancelled', 'The request was cancelled by the proposer'),
    ('Matched', 'A hosted match was scheduled for this request')
ON CONFLICT (value) DO UPDATE SET "description" = EXCLUDED."description";

ALTER TABLE "public"."match_options"
  ADD COLUMN IF NOT EXISTS "ranked" boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS public.team_scrim_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    team_id uuid NOT NULL UNIQUE REFERENCES public.teams (id) ON UPDATE cascade ON DELETE cascade,
    enabled boolean NOT NULL DEFAULT false,
    regions text[] NOT NULL DEFAULT '{}',
    map_ids uuid[] NOT NULL DEFAULT '{}',
    elo_min integer,
    elo_max integer,
    allow_outside_availability boolean NOT NULL DEFAULT false,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_scrim_settings_enabled
  ON public.team_scrim_settings (enabled);

CREATE TABLE IF NOT EXISTS public.team_scrim_availability (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    team_id uuid NOT NULL REFERENCES public.teams (id) ON UPDATE cascade ON DELETE cascade,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    recurring_weekly boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_scrim_availability_team
  ON public.team_scrim_availability (team_id);
CREATE INDEX IF NOT EXISTS idx_team_scrim_availability_window
  ON public.team_scrim_availability (starts_at, ends_at);

CREATE TABLE IF NOT EXISTS public.team_scrim_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    from_team_id uuid NOT NULL REFERENCES public.teams (id) ON UPDATE cascade ON DELETE cascade,
    to_team_id uuid NOT NULL REFERENCES public.teams (id) ON UPDATE cascade ON DELETE cascade,
    status text NOT NULL DEFAULT 'Pending' REFERENCES public.e_scrim_request_statuses (value) ON UPDATE cascade ON DELETE restrict,
    requested_by_steam_id bigint NOT NULL REFERENCES public.players (steam_id) ON UPDATE cascade ON DELETE cascade,
    awaiting_team_id uuid NOT NULL REFERENCES public.teams (id) ON UPDATE cascade ON DELETE cascade,
    proposed_scheduled_at timestamptz NOT NULL,
    region text,
    match_options_id uuid REFERENCES public.match_options (id) ON UPDATE cascade ON DELETE SET NULL,
    match_id uuid REFERENCES public.matches (id) ON UPDATE cascade ON DELETE SET NULL,
    expires_at timestamptz NOT NULL,
    auto_generated boolean NOT NULL DEFAULT false,
    canceled_late boolean NOT NULL DEFAULT false,
    canceled_by_team_id uuid REFERENCES public.teams (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    responded_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_team_scrim_requests_to_status
  ON public.team_scrim_requests (to_team_id, status);
CREATE INDEX IF NOT EXISTS idx_team_scrim_requests_from_status
  ON public.team_scrim_requests (from_team_id, status);
CREATE INDEX IF NOT EXISTS idx_team_scrim_requests_awaiting_status
  ON public.team_scrim_requests (awaiting_team_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_scrim_req_open
  ON public.team_scrim_requests (
    LEAST(from_team_id, to_team_id),
    GREATEST(from_team_id, to_team_id)
  )
  WHERE status IN ('Pending', 'Countered');

CREATE TABLE IF NOT EXISTS public.team_scrim_request_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    request_id uuid NOT NULL REFERENCES public.team_scrim_requests (id) ON UPDATE cascade ON DELETE cascade,
    proposed_by_team_id uuid NOT NULL REFERENCES public.teams (id) ON UPDATE cascade ON DELETE cascade,
    proposed_by_steam_id bigint NOT NULL REFERENCES public.players (steam_id) ON UPDATE cascade ON DELETE cascade,
    proposed_scheduled_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_scrim_request_proposals_request
  ON public.team_scrim_request_proposals (request_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.team_scrim_alerts (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    team_id uuid NOT NULL REFERENCES public.teams (id) ON UPDATE cascade ON DELETE cascade,
    enabled boolean NOT NULL DEFAULT true,
    regions text[] NOT NULL DEFAULT '{}',
    elo_min integer,
    elo_max integer,
    last_notified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_scrim_alerts_team
  ON public.team_scrim_alerts (team_id);

CREATE TABLE IF NOT EXISTS public.team_suggestions (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    member_steam_ids bigint[] NOT NULL,
    group_hash text NOT NULL UNIQUE,
    together_count integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'Suggested' CHECK (status IN ('Suggested', 'Dismissed', 'Created')),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_notified_at timestamptz
);

INSERT INTO public.settings (name, value)
  VALUES ('scrim_team_autodetect_min_overlap', '4')
  ON CONFLICT (name) DO NOTHING;
