-- Scrim reputation must not depend on the hosted match row surviving: canceled
-- scrim matches are deleted ~1 day after cancellation (RemoveCancelledMatches),
-- which would erase a team's no-shows from v_team_reputation. Snapshot the
-- outcome onto the request before the match is deleted instead.
ALTER TABLE public.team_scrim_requests
  ADD COLUMN IF NOT EXISTS match_outcome text,
  ADD COLUMN IF NOT EXISTS from_team_checked_in boolean,
  ADD COLUMN IF NOT EXISTS to_team_checked_in boolean;

COMMENT ON COLUMN public.team_scrim_requests.match_outcome IS
  'Terminal match status captured by tbd_match_cancel_scrim before the match row is deleted, so v_team_reputation survives canceled-match GC.';
