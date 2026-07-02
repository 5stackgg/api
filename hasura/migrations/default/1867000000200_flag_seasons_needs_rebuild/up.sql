-- One-time correction. A bug in the season ELO backfill (it adopted the global
-- off-season ladder instead of recomputing each match) left season ELO and
-- leaderboard standings incorrect. Existing installs have no way to know, so
-- flag every affected season for a rebuild.
--
-- This is a pure column signal: the admin UI reads seasons.needs_rebuild
-- directly and surfaces the rebuild action, so NO notification rows are created
-- (the flag clears itself when the backfill completes). Only flag seasons that
-- actually cover recorded 5stack (non-tournament) matches — an empty season
-- needs no rebuild.
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

-- Remove any "rebuild required" notifications left by an earlier version of this
-- fix — the nudge is now derived from seasons.needs_rebuild, not stored rows.
DELETE FROM public.notifications
WHERE type = 'EloRecompute'
  AND title LIKE '%ELO rebuild required';
