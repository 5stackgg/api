-- ── from 1873000000500_season_awards ─────────────────────────────────────────
DROP TRIGGER IF EXISTS tau_seasons_awards ON public.seasons;
DROP FUNCTION IF EXISTS public.tau_seasons_awards();
DROP FUNCTION IF EXISTS public.calculate_season_awards(uuid);

DO $$
BEGIN
  IF to_regclass('migration_hashes.hashes') IS NOT NULL THEN
    DELETE FROM migration_hashes.hashes
    WHERE name IN (
      'hasura/enums/award-sources',
      'hasura/functions/seasons/calculate_season_awards',
      'hasura/triggers/seasons_awards'
    );
  END IF;
END $$;

DELETE FROM public.awards
 WHERE system_key IN
   ('season_mvp', 'season_gold', 'season_silver', 'season_bronze');

ALTER TABLE public.award_recipients
    DROP CONSTRAINT IF EXISTS award_recipients_single_scope_check;

DROP INDEX IF EXISTS public.idx_award_recipients_league_season;
DROP INDEX IF EXISTS public.idx_award_recipients_event;
DROP INDEX IF EXISTS public.award_recipients_season_player_key;
DROP INDEX IF EXISTS public.idx_award_recipients_season;

ALTER TABLE public.award_recipients
    DROP COLUMN IF EXISTS league_season_id,
    DROP COLUMN IF EXISTS event_id,
    DROP COLUMN IF EXISTS season_id;

DELETE FROM public.e_award_sources WHERE value = 'season';

-- ── from 1873000000300_award_scopes ─────────────────────────────────────────
ALTER TABLE public.awards
    DROP CONSTRAINT IF EXISTS awards_single_scope_check;

DROP INDEX IF EXISTS public.idx_awards_league_season;
DROP INDEX IF EXISTS public.idx_awards_season;
DROP INDEX IF EXISTS public.idx_awards_event;

ALTER TABLE public.awards
    DROP COLUMN IF EXISTS league_season_id,
    DROP COLUMN IF EXISTS season_id,
    DROP COLUMN IF EXISTS event_id;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.awards'::regclass
          AND conname = 'awards_system_award_is_shared_check'
    ) THEN
        ALTER TABLE public.awards
            ADD CONSTRAINT awards_system_award_is_shared_check
            CHECK (system_key IS NULL OR tournament_id IS NULL);
    END IF;
END $$;

-- ── from 1873000000200_award_tournament_owner ─────────────────────────────────────────
ALTER TABLE public.awards
    DROP CONSTRAINT IF EXISTS awards_system_award_is_shared_check;

DROP INDEX IF EXISTS public.idx_awards_tournament;

ALTER TABLE public.awards
    DROP COLUMN IF EXISTS tournament_id;

-- ── from 1873000000100_awards ─────────────────────────────────────────
-- These are created in later boot phases (hasura/functions, hasura/triggers)
-- and are not reverted by re-running migrations, so they must be dropped here
-- before the tables they depend on.
DROP TRIGGER IF EXISTS tau_tournaments_awards ON public.tournaments;
DROP FUNCTION IF EXISTS public.tau_tournaments_awards();
DROP TRIGGER IF EXISTS tbi_award_recipients ON public.award_recipients;
DROP FUNCTION IF EXISTS public.tbi_award_recipients();
DROP TRIGGER IF EXISTS tbd_awards ON public.awards;
DROP FUNCTION IF EXISTS public.tbd_awards();
DROP FUNCTION IF EXISTS public.calculate_tournament_awards(uuid);
DROP FUNCTION IF EXISTS public.resolve_tournament_award(uuid, int);
DROP FUNCTION IF EXISTS public.recalculate_tournament_awards(uuid);
DROP FUNCTION IF EXISTS public._leaderboard_awards(INT, TEXT, UUID);

-- The boot loader (HasuraService.apply) skips re-creating a boot-phase object
-- when its stored digest is unchanged, so dropping the objects above is not
-- enough: without clearing their digests a later forward deploy would leave
-- the tables present but the functions/triggers gone. The setting name is the
-- cwd-relative path minus ".sql".
DO $$
BEGIN
  IF to_regclass('migration_hashes.hashes') IS NOT NULL THEN
    DELETE FROM migration_hashes.hashes
    WHERE name IN (
      'hasura/enums/award-tiers',
      'hasura/enums/award-sources',
      'hasura/functions/tournaments/calculate_tournament_awards',
      'hasura/functions/tournaments/recalculate_tournament_awards',
      'hasura/functions/tournaments/reset_tournament_match',
      'hasura/functions/leaderboard/get_leaderboard',
      'hasura/triggers/tournaments',
      'hasura/triggers/award_recipients',
      'hasura/triggers/awards'
    );
  END IF;
END $$;

DROP INDEX IF EXISTS public.idx_award_recipients_source;
DROP INDEX IF EXISTS public.idx_award_recipients_award;
DROP INDEX IF EXISTS public.award_recipients_one_mvp_per_tournament;

DELETE FROM public.award_recipients WHERE tournament_id IS NULL OR placement IS NULL;

ALTER TABLE public.award_recipients
    DROP CONSTRAINT IF EXISTS award_recipients_tournament_team_requires_tournament_check;

ALTER TABLE public.award_recipients
    ADD COLUMN IF NOT EXISTS manual boolean NOT NULL DEFAULT false;

UPDATE public.award_recipients SET manual = (source = 'manual');

ALTER TABLE public.award_recipients
    DROP COLUMN IF EXISTS award_id,
    DROP COLUMN IF EXISTS source,
    DROP COLUMN IF EXISTS awarded_by_steam_id,
    DROP COLUMN IF EXISTS note;

ALTER TABLE public.award_recipients
    ALTER COLUMN tournament_id SET NOT NULL,
    ALTER COLUMN tournament_team_id SET NOT NULL,
    ALTER COLUMN placement SET NOT NULL;

ALTER TABLE public.tournament_awards
    DROP COLUMN IF EXISTS award_id;

DO $$
DECLARE
    v_rename record;
BEGIN
    FOR v_rename IN
        SELECT * FROM (VALUES
            ('award_recipients_one_recipient_check', 'tournament_trophies_one_recipient_check'),
            ('award_recipients_mvp_requires_player_check', 'tournament_trophies_mvp_requires_player_check'),
            ('award_recipients_pkey', 'tournament_trophies_pkey'),
            ('award_recipients_placement_check', 'tournament_trophies_placement_check'),
            ('tournament_awards_pkey', 'tournament_trophy_configs_pkey'),
            ('tournament_awards_placement_check', 'tournament_trophy_configs_placement_check'),
            ('tournament_awards_silhouette_check', 'tournament_trophy_configs_silhouette_check'),
            ('tournament_awards_tournament_id_placement_key', 'tournament_trophy_configs_tournament_id_placement_key')
        ) AS t(old_name, new_name)
    LOOP
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_rename.old_name)
           AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_rename.new_name) THEN
            EXECUTE format(
                'ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
                CASE WHEN v_rename.old_name LIKE 'tournament_awards%'
                     THEN 'tournament_awards' ELSE 'award_recipients' END,
                v_rename.old_name, v_rename.new_name);
        END IF;
    END LOOP;

    FOR v_rename IN
        SELECT * FROM (VALUES
            ('idx_award_recipients_player', 'idx_tournament_trophies_player'),
            ('idx_award_recipients_tournament', 'idx_tournament_trophies_tournament'),
            ('idx_award_recipients_team', 'idx_tournament_trophies_team'),
            ('award_recipients_player_recipient_key', 'tournament_trophies_player_recipient_key'),
            ('award_recipients_team_recipient_key', 'tournament_trophies_team_recipient_key'),
            ('idx_tournament_awards_tournament', 'idx_tournament_trophy_configs_tournament')
        ) AS t(old_name, new_name)
    LOOP
        IF to_regclass('public.' || v_rename.old_name) IS NOT NULL
           AND to_regclass('public.' || v_rename.new_name) IS NULL THEN
            EXECUTE format('ALTER INDEX public.%I RENAME TO %I', v_rename.old_name, v_rename.new_name);
        END IF;
    END LOOP;
END $$;

ALTER TABLE public.award_recipients RENAME TO tournament_trophies;
ALTER TABLE public.tournament_awards RENAME TO tournament_trophy_configs;

CREATE UNIQUE INDEX IF NOT EXISTS tournament_trophies_one_mvp_per_tournament
    ON public.tournament_trophies(tournament_id)
    WHERE placement = 0;

ALTER TABLE public.tournaments RENAME COLUMN awards_enabled TO trophies_enabled;

DROP TABLE IF EXISTS public.awards;
DROP TABLE IF EXISTS public.e_award_sources;
DROP TABLE IF EXISTS public.e_award_tiers;

