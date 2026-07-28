ALTER TABLE public.pending_match_imports
    DROP COLUMN IF EXISTS parties;

DROP VIEW IF EXISTS public.v_player_queue_partners;

DROP INDEX IF EXISTS public.idx_match_lineup_players_party;

ALTER TABLE public.match_lineup_players
    DROP COLUMN IF EXISTS party_source,
    DROP COLUMN IF EXISTS party_id;

DROP TABLE IF EXISTS public.e_match_party_sources;

-- The boot loader (HasuraService.apply) skips re-creating a boot-phase object
-- when its stored digest is unchanged, so dropping the view above is not
-- enough: without clearing the digests a later forward deploy would leave the
-- columns present but the view gone. The name is the cwd-relative path
-- minus ".sql".
DO $$
BEGIN
  IF to_regclass('migration_hashes.hashes') IS NOT NULL THEN
    DELETE FROM migration_hashes.hashes
    WHERE name IN (
      'hasura/enums/match-party-sources',
      'hasura/views/v_player_queue_partners'
    );
  END IF;
END $$;
