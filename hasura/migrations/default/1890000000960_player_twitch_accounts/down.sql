DROP TABLE IF EXISTS public.player_twitch_accounts;

DROP FUNCTION IF EXISTS public.live_match_peers(bigint);

DO $$
BEGIN
  IF to_regclass('migration_hashes.hashes') IS NOT NULL THEN
    DELETE FROM migration_hashes.hashes
    WHERE name = 'hasura/functions/players/live_match_peers';
  END IF;
END $$;
