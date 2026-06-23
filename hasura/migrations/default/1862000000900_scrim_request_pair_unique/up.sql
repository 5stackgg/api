DROP INDEX IF EXISTS public.uq_scrim_req_open;

CREATE UNIQUE INDEX IF NOT EXISTS uq_scrim_req_open
  ON public.team_scrim_requests (
    LEAST(from_team_id, to_team_id),
    GREATEST(from_team_id, to_team_id)
  )
  WHERE status IN ('Pending', 'Countered');
