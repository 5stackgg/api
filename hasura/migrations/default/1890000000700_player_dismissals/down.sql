DROP TRIGGER IF EXISTS tbi_player_dismissals_steam_id ON public.player_dismissals;
DROP TABLE IF EXISTS public.player_dismissals;

DO $$
BEGIN
  IF to_regclass('migration_hashes.hashes') IS NOT NULL THEN
    DELETE FROM migration_hashes.hashes
    WHERE name = 'hasura/triggers/player_dismissals';
  END IF;
END $$;
