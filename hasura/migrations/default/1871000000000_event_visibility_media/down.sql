-- The access functions are created in a later boot phase (hasura/functions)
-- and depend on the columns dropped below (public.events row type includes
-- visibility/media_access/banner_media_id), so they must be dropped first.
-- get_event_leaderboard gains a hasura_session parameter in the same boot
-- phase; drop both signatures so either deployed version can re-apply.
DROP FUNCTION IF EXISTS public.get_event_leaderboard(UUID, TEXT, TEXT, INT, JSON);
DROP FUNCTION IF EXISTS public.get_event_leaderboard(UUID, TEXT, TEXT, INT);
DROP FUNCTION IF EXISTS public.can_upload_event_media(public.events, json);
DROP FUNCTION IF EXISTS public.can_view_event(public.events, json);
DROP FUNCTION IF EXISTS public.is_event_member(public.events, bigint);

-- Clear the boot-loader digests so the next boot re-applies the dropped
-- functions (see 1867000000300_events/down.sql for the full rationale).
DO $$
BEGIN
  IF to_regclass('migration_hashes.hashes') IS NOT NULL THEN
    DELETE FROM migration_hashes.hashes
    WHERE name IN (
      'hasura/functions/events/event_access',
      'hasura/functions/events/get_event_leaderboard'
    );
  END IF;
END $$;

DROP TRIGGER IF EXISTS tg_events_banner_same_event ON public.events;
DROP FUNCTION IF EXISTS public.tg_events_banner_same_event();

ALTER TABLE public.events DROP COLUMN IF EXISTS banner_media_id;
DROP TABLE IF EXISTS public.event_media;
ALTER TABLE public.events DROP COLUMN IF EXISTS visibility;
ALTER TABLE public.events DROP COLUMN IF EXISTS media_access;
DROP TABLE IF EXISTS public.e_event_visibility;
DROP TABLE IF EXISTS public.e_event_media_access;
