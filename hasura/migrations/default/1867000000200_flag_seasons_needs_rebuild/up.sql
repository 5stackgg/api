-- One-time correction. A bug in the season ELO backfill (it adopted the global
-- off-season ladder instead of recomputing each match) left season ELO and
-- leaderboard standings incorrect. Existing installs have no way to know, so
-- flag every affected season for a rebuild and notify admins.
--
-- Only touch installs that use seasons, and only seasons that actually cover
-- recorded 5stack (non-tournament) matches — an empty season needs no rebuild.
UPDATE public.seasons s
SET needs_rebuild = true
WHERE seasons_enabled()
  AND EXISTS (
      SELECT 1 FROM matches m
      WHERE m.source = '5stack'
        AND m.ended_at IS NOT NULL
        AND season_for_timestamp(m.ended_at) = s.id
        AND NOT EXISTS (
            SELECT 1 FROM tournament_brackets tb WHERE tb.match_id = m.id
        )
  );

-- One non-dismissible admin notification per flagged season, carrying a Rebuild
-- action that runs the season backfill directly. deletable=false + the presence
-- of an action means the only way to clear it is to click Rebuild (which starts
-- the backfill and removes the notification); admins can then watch progress on
-- the Seasons page.
INSERT INTO public.notifications (type, title, message, role, entity_id, deletable, actions)
SELECT
    'EloRecompute',
    'Season ' || s.number || ' ELO rebuild required',
    'A fix was applied to how season ELO is calculated. Rebuild this season''s '
    || 'ELO to correct standings — you can watch progress on the Seasons page.',
    'administrator',
    s.id::text,
    false,
    jsonb_build_array(
        jsonb_build_object(
            'label', 'Rebuild Season ELO',
            'graphql', jsonb_build_object(
                'type', 'mutation',
                'action', 'backfillSeasonElo',
                'selection', jsonb_build_object('success', true, 'running', true),
                'variables', jsonb_build_object('season_id', s.id::text)
            )
        )
    )
FROM public.seasons s
WHERE s.needs_rebuild = true
  AND seasons_enabled()
  AND EXISTS (
      SELECT 1 FROM public.e_notification_types WHERE value = 'EloRecompute'
  );
