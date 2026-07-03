-- These are created in later boot phases (hasura/functions, hasura/views)
-- and are not reverted by re-running migrations, so they must be dropped
-- here before the tables they depend on: v_event_player_stats reads
-- event_tournaments, and is_event_organizer takes public.events as its
-- first argument (a hard dependency on the table's row type).
DROP FUNCTION IF EXISTS public.get_event_leaderboard(UUID, TEXT, TEXT, INT);
DROP VIEW IF EXISTS public.v_event_player_stats;
DROP FUNCTION IF EXISTS public.is_event_organizer(public.events, json);

-- The boot loader (HasuraService.apply) skips re-creating a boot-phase object
-- when its stored digest is unchanged, so dropping the objects above is not
-- enough: without clearing their digests a later forward deploy would leave
-- the tables present but the view/functions gone. Clear the digests so the
-- next boot re-applies them. The setting name is the cwd-relative path minus
-- ".sql". Guard with to_regclass so this is a no-op when migration_hashes has
-- not been created yet (e.g. a rollback before the app has ever booted).
DO $$
BEGIN
  IF to_regclass('migration_hashes.hashes') IS NOT NULL THEN
    DELETE FROM migration_hashes.hashes
    WHERE name IN (
      'hasura/functions/events/get_event_leaderboard',
      'hasura/functions/events/is_event_organizer',
      'hasura/views/v_event_player_stats'
    );
  END IF;
END $$;

DROP TABLE IF EXISTS public.event_players;
DROP TABLE IF EXISTS public.event_teams;
DROP TABLE IF EXISTS public.event_tournaments;
DROP TABLE IF EXISTS public.event_organizers;
DROP TABLE IF EXISTS public.events;
DROP TABLE IF EXISTS public.e_event_status;
