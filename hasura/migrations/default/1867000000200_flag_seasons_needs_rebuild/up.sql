-- One-time correction. A bug in the season ELO backfill (it adopted the global
-- off-season ladder instead of recomputing each match) left season ELO and
-- leaderboard standings incorrect. Existing installs have no way to know, so
-- flag every season for a rebuild and notify admins once to re-run it.
UPDATE public.seasons SET needs_rebuild = true;

-- Only nudge installs that actually use seasons. The Seasons page shows the
-- rebuild (with progress) per season; a global "Recompute Player ELO" also
-- rebuilds every season, so either path corrects standings.
INSERT INTO public.notifications (type, title, message, role)
SELECT
    'EloRecompute',
    'Season ELO rebuild required',
    'A fix was applied to how season ELO is calculated. Rebuild each season''s '
    || 'ELO from the Seasons page (or run Recompute Player ELO) to correct standings.',
    'administrator'
WHERE seasons_enabled()
  AND EXISTS (SELECT 1 FROM public.seasons)
  AND EXISTS (
      SELECT 1 FROM public.e_notification_types WHERE value = 'EloRecompute'
  );
