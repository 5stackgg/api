-- Awards: catalog + recipients, scopes, and season placements.
-- Squashed from the original award migrations; every statement is
-- idempotent so it applies to a fresh database and to one that already
-- ran the earlier split versions.

-- ── from 1873000000100_awards ─────────────────────────────────────────
-- Awards: promote tournament trophies into a first-class awards system.
--
-- tournament_trophies fused two ideas: what the award IS (name / artwork) and
-- WHO holds it. Splitting them lets awards be authored on their own and handed
-- out outside a tournament, while tournament placements stay automated.

CREATE TABLE IF NOT EXISTS public.e_award_tiers (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);

INSERT INTO public.e_award_tiers (value, description) VALUES
    ('mvp', 'Most valuable player'),
    ('gold', 'First place'),
    ('silver', 'Second place'),
    ('bronze', 'Third place'),
    ('special', 'Standalone award')
ON CONFLICT (value) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.e_award_sources (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);

INSERT INTO public.e_award_sources (value, description) VALUES
    ('tournament', 'Calculated from a tournament placement'),
    ('manual', 'Granted by hand')
ON CONFLICT (value) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.awards (
    id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    name text NOT NULL,
    description text,
    tier text NOT NULL DEFAULT 'special'
        REFERENCES public.e_award_tiers(value),
    silhouette int CHECK (silhouette IS NULL OR (silhouette >= 0 AND silhouette <= 4)),
    image_url text,
    -- Set only on the seeded awards the tournament automation falls back to.
    -- These cannot be deleted; everything else in the catalog can.
    system_key text UNIQUE,
    allow_multiple boolean NOT NULL DEFAULT false,
    created_by_steam_id bigint REFERENCES public.players(steam_id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.awards (name, description, tier, system_key, allow_multiple) VALUES
    ('Tournament MVP', 'Best performer on the winning roster', 'mvp', 'tournament_mvp', true),
    ('Tournament Champion', 'Won the tournament', 'gold', 'tournament_gold', true),
    ('Tournament Runner-Up', 'Finished second', 'silver', 'tournament_silver', true),
    ('Tournament Third Place', 'Finished third', 'bronze', 'tournament_bronze', true)
ON CONFLICT (system_key) DO NOTHING;

-- The boot phases that re-create functions/triggers run AFTER migrations, so a
-- trigger left bound to the old name would fire against a table that no longer
-- exists and break every tournament UPDATE in the window between the two.
DROP TRIGGER IF EXISTS tau_tournaments_trophies ON public.tournaments;
DROP FUNCTION IF EXISTS public.tau_tournaments_trophies();
DROP FUNCTION IF EXISTS public.calculate_tournament_trophies(uuid);
DROP FUNCTION IF EXISTS public.recalculate_tournament_trophies(uuid);
DROP FUNCTION IF EXISTS public._leaderboard_trophies(INT, TEXT, UUID);

DO $$
BEGIN
    IF to_regclass('public.tournament_trophies') IS NOT NULL
       AND to_regclass('public.award_recipients') IS NULL THEN
        ALTER TABLE public.tournament_trophies RENAME TO award_recipients;
    END IF;

    IF to_regclass('public.tournament_trophy_configs') IS NOT NULL
       AND to_regclass('public.tournament_awards') IS NULL THEN
        ALTER TABLE public.tournament_trophy_configs RENAME TO tournament_awards;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tournaments'
          AND column_name = 'trophies_enabled'
    ) THEN
        ALTER TABLE public.tournaments RENAME COLUMN trophies_enabled TO awards_enabled;
    END IF;
END $$;

ALTER TABLE public.tournaments
    ADD COLUMN IF NOT EXISTS awards_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE public.tournament_awards
    ADD COLUMN IF NOT EXISTS award_id uuid REFERENCES public.awards(id) ON DELETE SET NULL;

ALTER TABLE public.award_recipients
    ADD COLUMN IF NOT EXISTS award_id uuid REFERENCES public.awards(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS source text REFERENCES public.e_award_sources(value),
    ADD COLUMN IF NOT EXISTS awarded_by_steam_id bigint REFERENCES public.players(steam_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS note text;

UPDATE public.award_recipients recipient
   SET award_id = award.id
  FROM public.awards award
 WHERE recipient.award_id IS NULL
   AND award.system_key = CASE recipient.placement
        WHEN 0 THEN 'tournament_mvp'
        WHEN 1 THEN 'tournament_gold'
        WHEN 2 THEN 'tournament_silver'
        WHEN 3 THEN 'tournament_bronze'
   END;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'award_recipients'
          AND column_name = 'manual'
    ) THEN
        UPDATE public.award_recipients
           SET source = CASE WHEN manual THEN 'manual' ELSE 'tournament' END
         WHERE source IS NULL;

        ALTER TABLE public.award_recipients DROP COLUMN manual;
    END IF;
END $$;

UPDATE public.award_recipients SET source = 'tournament' WHERE source IS NULL;

ALTER TABLE public.award_recipients
    ALTER COLUMN award_id SET NOT NULL,
    ALTER COLUMN source SET NOT NULL,
    ALTER COLUMN source SET DEFAULT 'manual',
    ALTER COLUMN tournament_id DROP NOT NULL,
    ALTER COLUMN tournament_team_id DROP NOT NULL,
    ALTER COLUMN placement DROP NOT NULL;

-- A tournament team only means anything alongside its tournament.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.award_recipients'::regclass
          AND conname = 'award_recipients_tournament_team_requires_tournament_check'
    ) THEN
        ALTER TABLE public.award_recipients
            ADD CONSTRAINT award_recipients_tournament_team_requires_tournament_check
            CHECK (tournament_team_id IS NULL OR tournament_id IS NOT NULL);
    END IF;
END $$;

DO $$
DECLARE
    v_rename record;
BEGIN
    FOR v_rename IN
        SELECT * FROM (VALUES
            ('tournament_trophies_one_recipient_check', 'award_recipients_one_recipient_check'),
            ('tournament_trophies_mvp_requires_player_check', 'award_recipients_mvp_requires_player_check'),
            ('tournament_trophies_pkey', 'award_recipients_pkey'),
            ('tournament_trophies_placement_check', 'award_recipients_placement_check'),
            ('tournament_trophy_configs_pkey', 'tournament_awards_pkey'),
            ('tournament_trophy_configs_placement_check', 'tournament_awards_placement_check'),
            ('tournament_trophy_configs_silhouette_check', 'tournament_awards_silhouette_check'),
            ('tournament_trophy_configs_tournament_id_placement_key', 'tournament_awards_tournament_id_placement_key')
        ) AS t(old_name, new_name)
    LOOP
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_rename.old_name)
           AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_rename.new_name) THEN
            EXECUTE format(
                'ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
                CASE WHEN v_rename.old_name LIKE 'tournament_trophy_configs%'
                     THEN 'tournament_awards' ELSE 'award_recipients' END,
                v_rename.old_name, v_rename.new_name);
        END IF;
    END LOOP;

    FOR v_rename IN
        SELECT * FROM (VALUES
            ('idx_tournament_trophies_player', 'idx_award_recipients_player'),
            ('idx_tournament_trophies_tournament', 'idx_award_recipients_tournament'),
            ('idx_tournament_trophies_team', 'idx_award_recipients_team'),
            ('tournament_trophies_player_recipient_key', 'award_recipients_player_recipient_key'),
            ('tournament_trophies_team_recipient_key', 'award_recipients_team_recipient_key'),
            ('idx_tournament_trophy_configs_tournament', 'idx_tournament_awards_tournament')
        ) AS t(old_name, new_name)
    LOOP
        IF to_regclass('public.' || v_rename.old_name) IS NOT NULL
           AND to_regclass('public.' || v_rename.new_name) IS NULL THEN
            EXECUTE format('ALTER INDEX public.%I RENAME TO %I', v_rename.old_name, v_rename.new_name);
        END IF;
    END LOOP;
END $$;

-- Placement-less awards have no tournament, so the MVP guard must not collapse
-- them onto a single NULL bucket.
DROP INDEX IF EXISTS public.tournament_trophies_one_mvp_per_tournament;
CREATE UNIQUE INDEX IF NOT EXISTS award_recipients_one_mvp_per_tournament
    ON public.award_recipients(tournament_id)
    WHERE placement = 0 AND tournament_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_award_recipients_award
    ON public.award_recipients(award_id);
CREATE INDEX IF NOT EXISTS idx_award_recipients_source
    ON public.award_recipients(tournament_id, source);

-- ── from 1873000000200_award_tournament_owner ─────────────────────────────────────────
-- Awards authored from inside a tournament remember where they came from, so
-- the catalog can group them and other tournaments' pickers can hide them.
-- Nullable: catalog awards created from the awards page stay shared, and the
-- seeded system awards are never owned by anyone.
ALTER TABLE public.awards
    ADD COLUMN IF NOT EXISTS tournament_id uuid
        REFERENCES public.tournaments(id) ON DELETE SET NULL;

-- Deleting the tournament must not take the award (and every grant hanging off
-- it) with it, hence SET NULL above: the award simply becomes unaffiliated.
CREATE INDEX IF NOT EXISTS idx_awards_tournament
    ON public.awards(tournament_id)
    WHERE tournament_id IS NOT NULL;

-- A built-in is shared by definition.
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

-- ── from 1873000000300_award_scopes ─────────────────────────────────────────
-- Awards can be scoped to whatever they were created for. Separate nullable
-- FKs rather than a (scope_type, scope_id) pair so Postgres still enforces
-- referential integrity and Hasura can expose a real relationship per scope.
--
-- There is no `leagues` table (the platform runs one global league), so the
-- league-shaped scope hangs off league_seasons.
ALTER TABLE public.awards
    ADD COLUMN IF NOT EXISTS event_id uuid
        REFERENCES public.events(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS season_id uuid
        REFERENCES public.seasons(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS league_season_id uuid
        REFERENCES public.league_seasons(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_awards_event
    ON public.awards(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_awards_season
    ON public.awards(season_id) WHERE season_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_awards_league_season
    ON public.awards(league_season_id) WHERE league_season_id IS NOT NULL;

-- Superseded by the all-scopes check below.
ALTER TABLE public.awards
    DROP CONSTRAINT IF EXISTS awards_system_award_is_shared_check;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.awards'::regclass
          AND conname = 'awards_single_scope_check'
    ) THEN
        ALTER TABLE public.awards
            ADD CONSTRAINT awards_single_scope_check
            CHECK (
                (CASE WHEN tournament_id IS NULL THEN 0 ELSE 1 END) +
                (CASE WHEN event_id IS NULL THEN 0 ELSE 1 END) +
                (CASE WHEN season_id IS NULL THEN 0 ELSE 1 END) +
                (CASE WHEN league_season_id IS NULL THEN 0 ELSE 1 END)
                <= CASE WHEN system_key IS NULL THEN 1 ELSE 0 END
            );
    END IF;
END $$;

-- ── from 1873000000500_season_awards ─────────────────────────────────────────
-- Season placements are calculated the same way tournament placements are, so
-- the recipient row needs to record which season it came from. Without this a
-- shared system award could not say which season it was won in.
ALTER TABLE public.award_recipients
    ADD COLUMN IF NOT EXISTS season_id uuid
        REFERENCES public.seasons(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_award_recipients_season
    ON public.award_recipients(season_id, source)
    WHERE season_id IS NOT NULL;

-- Keeps a recalculation idempotent, mirroring the tournament recipient keys.
CREATE UNIQUE INDEX IF NOT EXISTS award_recipients_season_player_key
    ON public.award_recipients(season_id, player_steam_id, placement)
    WHERE season_id IS NOT NULL AND player_steam_id IS NOT NULL;

-- Recipients can be scoped to every context `awards` can, otherwise a grant made
-- from an event or league season page loses what it was given for.
ALTER TABLE public.award_recipients
    ADD COLUMN IF NOT EXISTS event_id uuid
        REFERENCES public.events(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS league_season_id uuid
        REFERENCES public.league_seasons(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_award_recipients_event
    ON public.award_recipients(event_id, source) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_award_recipients_league_season
    ON public.award_recipients(league_season_id, source)
    WHERE league_season_id IS NOT NULL;

-- A grant belongs to one context, mirroring awards_single_scope_check.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.award_recipients'::regclass
          AND conname = 'award_recipients_single_scope_check'
    ) THEN
        ALTER TABLE public.award_recipients
            ADD CONSTRAINT award_recipients_single_scope_check
            CHECK (
                (CASE WHEN tournament_id IS NULL THEN 0 ELSE 1 END) +
                (CASE WHEN season_id IS NULL THEN 0 ELSE 1 END) +
                (CASE WHEN event_id IS NULL THEN 0 ELSE 1 END) +
                (CASE WHEN league_season_id IS NULL THEN 0 ELSE 1 END) <= 1
            );
    END IF;
END $$;

INSERT INTO public.e_award_sources (value, description) VALUES
    ('season', 'Calculated from a season standing')
ON CONFLICT (value) DO NOTHING;

INSERT INTO public.awards (name, description, tier, system_key, allow_multiple) VALUES
    ('Season MVP', 'Highest impact across the season', 'mvp', 'season_mvp', true),
    ('Season Champion', 'Finished the season top of the ladder', 'gold', 'season_gold', true),
    ('Season Runner-Up', 'Finished the season second', 'silver', 'season_silver', true),
    ('Season Third Place', 'Finished the season third', 'bronze', 'season_bronze', true)
ON CONFLICT (system_key) DO NOTHING;

