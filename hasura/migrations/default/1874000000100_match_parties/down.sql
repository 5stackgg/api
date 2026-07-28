ALTER TABLE public.pending_match_imports
    DROP COLUMN IF EXISTS parties;

DROP VIEW IF EXISTS public.v_player_queue_partners;

DROP TRIGGER IF EXISTS tai_match_lineup_players_parties ON public.match_lineup_players;
DROP FUNCTION IF EXISTS public.tai_match_lineup_players_parties();
DROP FUNCTION IF EXISTS public.assign_lobby_parties(uuid);

DROP INDEX IF EXISTS public.idx_match_lineup_players_party;

ALTER TABLE public.match_lineup_players
    DROP COLUMN IF EXISTS party_source,
    DROP COLUMN IF EXISTS party_id;

DROP TABLE IF EXISTS public.e_match_party_sources;

-- HasuraService.apply skips a boot-phase object whose digest is unchanged, so
-- the digests must go too or a forward deploy leaves the view dropped.
DO $$
BEGIN
  IF to_regclass('migration_hashes.hashes') IS NOT NULL THEN
    DELETE FROM migration_hashes.hashes
    WHERE name IN (
      'hasura/enums/match-party-sources',
      'hasura/functions/match/assign_lobby_parties',
      'hasura/triggers/match_lineup_players',
      'hasura/views/v_player_queue_partners'
    );
  END IF;
END $$;
