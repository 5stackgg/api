-- Migrations run before hasura/functions are applied, so this cannot call
-- season_for_timestamp(); inline its range check instead (non-overlap of
-- seasons is enforced by an exclusion constraint, so at most one matches).
UPDATE public.seasons s
SET needs_rebuild = true
WHERE EXISTS (
    SELECT 1 FROM matches m
    WHERE m.source = '5stack'
      AND m.ended_at IS NOT NULL
      AND m.ended_at >= s.starts_at
      AND (s.ends_at IS NULL OR m.ended_at < s.ends_at)
      AND NOT EXISTS (
          SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = m.id
      )
);
