ALTER TABLE public.teams ADD COLUMN created_at timestamptz;

-- Teams made before this column existed get their earliest trace: the first
-- match they played or the first invite they sent. A team with neither stays
-- null rather than claiming it was founded today.
UPDATE public.teams t
   SET created_at = first_seen.at
  FROM (
        SELECT traces.team_id, min(traces.at) AS at
          FROM (
                SELECT ml.team_id, m.created_at AS at
                  FROM public.match_lineups ml
                  JOIN public.matches m ON m.id = ml.match_id
                 WHERE ml.team_id IS NOT NULL
                UNION ALL
                SELECT ti.team_id, ti.created_at
                  FROM public.team_invites ti
               ) traces
         GROUP BY traces.team_id
       ) first_seen
 WHERE first_seen.team_id = t.id;

ALTER TABLE public.teams ALTER COLUMN created_at SET DEFAULT now();
