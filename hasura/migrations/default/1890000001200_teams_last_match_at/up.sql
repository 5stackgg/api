-- The teams directory sorts on this by default. As a computed field it kept
-- Hasura from applying the page LIMIT until every team's row had been built,
-- so it is stored and kept current by hasura/triggers/team_last_match_at.sql.
ALTER TABLE public.teams ADD COLUMN IF NOT EXISTS last_match_at timestamptz;

UPDATE public.teams t
SET last_match_at = s.last_match_at
FROM (
    SELECT ml.team_id, max(COALESCE(m.ended_at, m.started_at)) AS last_match_at
    FROM public.match_lineups ml
    INNER JOIN public.matches m ON m.id = ml.match_id
    WHERE ml.team_id IS NOT NULL
      AND m.started_at IS NOT NULL
    GROUP BY ml.team_id
) s
WHERE t.id = s.team_id;

DROP FUNCTION IF EXISTS public.team_last_match_at(public.teams);
