-- Every event must have a start date. The start date is the lower bound of
-- the event window in public.v_event_matches: a match belongs to the event
-- only when it falls in [starts_at, ends_at + 1 day) AND involves a tracked
-- team/player (or sits in an attached tournament's bracket). Without a start
-- date the window opened to -infinity and pulled in an attached team's or
-- player's entire match history (lifetime stats/highlights).
--
-- Backfill existing dateless events to today, then enforce NOT NULL. Setting
-- starts_at fires tg_events_sync_match_links (AFTER UPDATE OF starts_at), so
-- event_match_links is re-derived for each backfilled event as part of this
-- migration.
UPDATE public.events
   SET starts_at = date_trunc('day', now())
 WHERE starts_at IS NULL;

-- New events without an explicit start default to today rather than being
-- rejected outright; the event form also requires the field.
ALTER TABLE public.events
    ALTER COLUMN starts_at SET DEFAULT date_trunc('day', now());

ALTER TABLE public.events
    ALTER COLUMN starts_at SET NOT NULL;
