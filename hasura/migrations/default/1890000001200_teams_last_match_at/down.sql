DROP TRIGGER IF EXISTS taiud_match_lineups_team_last_match_at ON public.match_lineups;
DROP TRIGGER IF EXISTS tau_matches_team_last_match_at ON public.matches;
DROP FUNCTION IF EXISTS public.taiud_match_lineups_team_last_match_at();
DROP FUNCTION IF EXISTS public.tau_matches_team_last_match_at();
DROP FUNCTION IF EXISTS public.recompute_team_last_match_at(uuid);

CREATE OR REPLACE FUNCTION public.team_last_match_at(team public.teams)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
    SELECT max(COALESCE(m.ended_at, m.started_at))
    FROM match_lineups ml
    INNER JOIN matches m ON m.id = ml.match_id
    WHERE ml.team_id = team.id
      AND m.started_at IS NOT NULL;
$$;

ALTER TABLE public.teams DROP COLUMN IF EXISTS last_match_at;
