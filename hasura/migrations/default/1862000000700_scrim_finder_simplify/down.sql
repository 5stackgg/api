ALTER TABLE public.team_scrim_requests
  DROP COLUMN IF EXISTS match_options_id;

ALTER TABLE public.team_scrim_settings
  ADD COLUMN IF NOT EXISTS hosting_preference text NOT NULL DEFAULT 'either'
    CHECK (hosting_preference IN ('host', 'guest', 'either')),
  ADD COLUMN IF NOT EXISTS match_options_id uuid
    REFERENCES public.match_options (id) ON UPDATE cascade ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS faceit_level_min integer,
  ADD COLUMN IF NOT EXISTS faceit_level_max integer,
  ADD COLUMN IF NOT EXISTS premier_min integer,
  ADD COLUMN IF NOT EXISTS premier_max integer;

ALTER TABLE public.team_scrim_alerts
  ADD COLUMN IF NOT EXISTS faceit_level_min integer,
  ADD COLUMN IF NOT EXISTS faceit_level_max integer,
  ADD COLUMN IF NOT EXISTS premier_min integer,
  ADD COLUMN IF NOT EXISTS premier_max integer;
