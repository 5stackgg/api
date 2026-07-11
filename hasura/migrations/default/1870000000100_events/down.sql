-- These are created in later boot phases (hasura/functions, hasura/views,
-- hasura/triggers) and are not reverted by re-running migrations, so they
-- must be dropped here before the tables they depend on.
DROP FUNCTION IF EXISTS public.get_event_leaderboard(UUID, TEXT, TEXT, INT, JSON);
DROP FUNCTION IF EXISTS public.get_event_leaderboard(UUID, TEXT, TEXT, INT);
DROP VIEW IF EXISTS public.v_event_player_stats;
DROP VIEW IF EXISTS public.v_event_matches;
DROP FUNCTION IF EXISTS public.can_upload_event_media(public.events, json);
DROP FUNCTION IF EXISTS public.can_view_event(public.events, json);
DROP FUNCTION IF EXISTS public.is_event_member(public.events, bigint);
DROP FUNCTION IF EXISTS public.is_event_organizer(public.events, json);

DROP TRIGGER IF EXISTS tg_events_sync_match_links ON public.events;
DROP TRIGGER IF EXISTS tg_event_teams_sync_match_links ON public.event_teams;
DROP TRIGGER IF EXISTS tg_event_players_sync_match_links ON public.event_players;
DROP TRIGGER IF EXISTS tg_event_tournaments_sync_match_links ON public.event_tournaments;
DROP TRIGGER IF EXISTS tg_brackets_sync_event_match_links ON public.tournament_brackets;
DROP TRIGGER IF EXISTS tg_matches_sync_event_match_links ON public.matches;
DROP TRIGGER IF EXISTS tg_mlp_sync_event_match_links ON public.match_lineup_players;
DROP FUNCTION IF EXISTS public.tg_sync_event_match_links();
DROP FUNCTION IF EXISTS public.tg_sync_event_match_links_membership();
DROP FUNCTION IF EXISTS public.tg_sync_event_match_links_bracket();
DROP FUNCTION IF EXISTS public.tg_sync_event_match_links_match();
DROP FUNCTION IF EXISTS public.tg_sync_event_match_links_mlp();
DROP FUNCTION IF EXISTS public.sync_event_match_links(uuid);
DROP FUNCTION IF EXISTS public.sync_match_event_links(uuid);

-- The boot loader (HasuraService.apply) skips re-creating a boot-phase object
-- when its stored digest is unchanged, so dropping the objects above is not
-- enough: without clearing their digests a later forward deploy would leave
-- the tables present but the views/functions/triggers gone. Clear the digests
-- so the next boot re-applies them. The setting name is the cwd-relative path
-- minus ".sql". Guard with to_regclass so this is a no-op when
-- migration_hashes has not been created yet (e.g. a rollback before the app
-- has ever booted).
DO $$
BEGIN
  IF to_regclass('migration_hashes.hashes') IS NOT NULL THEN
    DELETE FROM migration_hashes.hashes
    WHERE name IN (
      'hasura/functions/events/event_access',
      'hasura/functions/events/get_event_leaderboard',
      'hasura/functions/events/is_event_organizer',
      'hasura/views/v_event_matches',
      'hasura/views/v_event_player_stats',
      'hasura/triggers/event_match_links'
    );
  END IF;
END $$;

DROP TRIGGER IF EXISTS tg_events_banner_same_event ON public.events;
DROP FUNCTION IF EXISTS public.tg_events_banner_same_event();

DROP TABLE IF EXISTS public.event_match_links;
DROP TABLE IF EXISTS public.event_media_players;
ALTER TABLE public.events DROP COLUMN IF EXISTS banner_media_id;
DROP TABLE IF EXISTS public.event_media;
DROP TABLE IF EXISTS public.event_players;
DROP TABLE IF EXISTS public.event_teams;
DROP TABLE IF EXISTS public.event_tournaments;
DROP TABLE IF EXISTS public.event_organizers;
DROP TABLE IF EXISTS public.events;
DROP TABLE IF EXISTS public.e_event_visibility;
DROP TABLE IF EXISTS public.e_event_media_access;
