-- The sync functions/triggers are created in the triggers boot phase and
-- depend on this table; drop them and clear their digest so the next boot of
-- an older release is consistent (see 1867000000300_events/down.sql).
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

-- v_event_player_stats reads from the link table in this release; drop it so
-- the table drop succeeds, and clear its digest so the previous release's
-- version re-applies on next boot.
DROP VIEW IF EXISTS public.v_event_player_stats;

DO $$
BEGIN
  IF to_regclass('migration_hashes.hashes') IS NOT NULL THEN
    DELETE FROM migration_hashes.hashes
    WHERE name IN (
      'hasura/triggers/event_match_links',
      'hasura/views/v_event_player_stats'
    );
  END IF;
END $$;

DROP TABLE IF EXISTS public.event_match_links;
