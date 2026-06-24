ALTER TABLE public.team_scrim_requests
  DROP COLUMN IF EXISTS match_outcome,
  DROP COLUMN IF EXISTS from_team_checked_in,
  DROP COLUMN IF EXISTS to_team_checked_in;
