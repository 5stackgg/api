UPDATE public.seasons s
SET needs_rebuild = true
WHERE EXISTS (
    SELECT 1 FROM matches m
    WHERE m.source = '5stack'
      AND m.ended_at IS NOT NULL
      AND season_for_timestamp(m.ended_at) = s.id
      AND NOT EXISTS (
          SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = m.id
      )
);
