DROP TABLE IF EXISTS public.player_twitch_accounts;

DROP FUNCTION IF EXISTS public.live_match_peers(bigint);
DROP FUNCTION IF EXISTS public.live_match_participants();

DO $$
BEGIN
  IF to_regclass('migration_hashes.hashes') IS NOT NULL THEN
    DELETE FROM migration_hashes.hashes
    WHERE name IN ('hasura/functions/players/live_match_peers',
                   'hasura/functions/players/live_match_participants');
  END IF;
END $$;
