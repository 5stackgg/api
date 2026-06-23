-- Preferences are now just ELO + region. Match format moves to the request:
-- the requester sets up match options (best of X) when challenging a team.

ALTER TABLE public.team_scrim_settings
  DROP COLUMN IF EXISTS hosting_preference,
  DROP COLUMN IF EXISTS match_options_id,
  DROP COLUMN IF EXISTS faceit_level_min,
  DROP COLUMN IF EXISTS faceit_level_max,
  DROP COLUMN IF EXISTS premier_min,
  DROP COLUMN IF EXISTS premier_max;

ALTER TABLE public.team_scrim_requests
  ADD COLUMN IF NOT EXISTS match_options_id uuid
    REFERENCES public.match_options (id) ON UPDATE cascade ON DELETE SET NULL;

ALTER TABLE public.team_scrim_alerts
  DROP COLUMN IF EXISTS faceit_level_min,
  DROP COLUMN IF EXISTS faceit_level_max,
  DROP COLUMN IF EXISTS premier_min,
  DROP COLUMN IF EXISTS premier_max;
