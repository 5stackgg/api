-- Player columns for the global Premier rank snapshot.
ALTER TABLE "public"."players"
  ADD COLUMN IF NOT EXISTS "premier_rank" integer,
  ADD COLUMN IF NOT EXISTS "premier_rank_updated_at" timestamptz;

-- Per-user Steam match-history linkage (auth_code + last_known_share_code).
CREATE TABLE IF NOT EXISTS "public"."player_steam_match_auth" (
  "steam_id" bigint NOT NULL,
  "auth_code" text NOT NULL,
  "last_known_share_code" text NOT NULL,
  "last_polled_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("steam_id"),
  FOREIGN KEY ("steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade
);

-- Premier as a first-class match type alongside Competitive/Wingman/Duel.
INSERT INTO public.e_match_types ("value", "description") VALUES
  ('Premier', 'Valve Premier matchmaking — 5 vs 5 with CS Rating')
ON CONFLICT (value) DO UPDATE SET "description" = EXCLUDED."description";

-- Tag every match with where it came from. Default keeps existing rows on '5stack'.
ALTER TABLE "public"."matches"
  ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT '5stack';

CREATE INDEX IF NOT EXISTS idx_matches_5stack_ended_at
  ON public.matches (ended_at DESC)
  WHERE source = '5stack' AND ended_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_matches_external_created_at
  ON public.matches (source, created_at DESC)
  WHERE source <> '5stack';

CREATE INDEX IF NOT EXISTS idx_match_map_demos_file
  ON public.match_map_demos (file);

CREATE INDEX IF NOT EXISTS idx_players_last_sign_in_at
  ON public.players (last_sign_in_at DESC)
  WHERE last_sign_in_at IS NOT NULL;

-- Pending-import queue: one row per valve_match_id, many requesters.
CREATE TABLE IF NOT EXISTS "public"."pending_match_imports" (
  "valve_match_id" numeric NOT NULL,
  "share_code" text NOT NULL,
  "status" text NOT NULL DEFAULT 'Queued',
  "error" text,
  "map_name" text,
  "match_start_time" timestamptz,
  "demo_url" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("valve_match_id")
);

CREATE INDEX IF NOT EXISTS idx_pending_match_imports_status
  ON public.pending_match_imports (status);

CREATE TABLE IF NOT EXISTS "public"."pending_match_import_players" (
  "valve_match_id" numeric NOT NULL,
  "steam_id" bigint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("valve_match_id", "steam_id"),
  FOREIGN KEY ("valve_match_id") REFERENCES "public"."pending_match_imports"("valve_match_id") ON UPDATE cascade ON DELETE cascade,
  FOREIGN KEY ("steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS idx_pending_match_import_players_steam_id
  ON public.pending_match_import_players (steam_id);

-- Per-match Valve rank history. Premier (rank_type 11) is global (map_id NULL);
-- Wingman (6) and Competitive (7) are per map. previous_rank stores the prior
-- rank of the same type (and map, for skill groups) so the delta is exact.
CREATE TABLE IF NOT EXISTS "public"."player_premier_rank_history" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "steam_id" bigint NOT NULL,
  "rank" integer NOT NULL,
  "rank_type" integer NOT NULL DEFAULT 11,
  "previous_rank" integer,
  "map_id" uuid,
  "match_id" uuid NOT NULL,
  "observed_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  FOREIGN KEY ("steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade,
  FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON UPDATE cascade ON DELETE cascade
);

-- Converge columns if the table pre-existed from an earlier migration.
ALTER TABLE "public"."player_premier_rank_history"
  ADD COLUMN IF NOT EXISTS "rank_type" integer NOT NULL DEFAULT 11,
  ADD COLUMN IF NOT EXISTS "previous_rank" integer,
  ADD COLUMN IF NOT EXISTS "map_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'player_rank_history_map_id_fkey'
      AND table_name = 'player_premier_rank_history'
  ) THEN
    ALTER TABLE "public"."player_premier_rank_history"
      ADD CONSTRAINT "player_rank_history_map_id_fkey"
      FOREIGN KEY ("map_id") REFERENCES "public"."maps"("id")
      ON UPDATE cascade ON DELETE set null;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_player_premier_rank_history_steam_observed
  ON public.player_premier_rank_history (steam_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_player_premier_rank_history_steam_type_observed
  ON public.player_premier_rank_history (steam_id, rank_type, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_player_rank_history_steam_type_map_observed
  ON public.player_premier_rank_history (steam_id, rank_type, map_id, observed_at DESC);

-- Uniqueness is per (player, match, rank_type). Drop the older steam+match
-- index if a prior migration created it.
DROP INDEX IF EXISTS public.uq_player_premier_rank_history_steam_match;
CREATE UNIQUE INDEX IF NOT EXISTS uq_player_premier_rank_history_steam_match_type
  ON public.player_premier_rank_history (steam_id, match_id, rank_type);

-- Competitive/Wingman are per map (history only) — drop any global snapshot
-- columns an earlier migration may have added.
ALTER TABLE "public"."players"
  DROP COLUMN IF EXISTS "competitive_rank",
  DROP COLUMN IF EXISTS "competitive_rank_updated_at",
  DROP COLUMN IF EXISTS "wingman_rank",
  DROP COLUMN IF EXISTS "wingman_rank_updated_at";

-- match_map_demos.match_id was the only RESTRICT FK to matches; flip it
-- to CASCADE so `DELETE FROM matches` cleans up the demo metadata row.
ALTER TABLE "public"."match_map_demos"
  DROP CONSTRAINT IF EXISTS "match_demos_match_id_fkey";

ALTER TABLE "public"."match_map_demos"
  ADD CONSTRAINT "match_demos_match_id_fkey"
  FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id")
  ON UPDATE CASCADE ON DELETE CASCADE;


-- Steam account pool: shared logins claimed by streaming/demo/clip workers.
CREATE TABLE IF NOT EXISTS "public"."steam_accounts" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "username" text NOT NULL,
  "password" text NOT NULL,
  "last_node_id" text NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  UNIQUE ("username"),
  FOREIGN KEY ("last_node_id")
    REFERENCES "public"."game_server_nodes" ("id")
    ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "steam_accounts_last_node_id_idx"
  ON "public"."steam_accounts" ("last_node_id")
  WHERE "last_node_id" IS NOT NULL;


ALTER TABLE "public"."match_streams"
  ADD COLUMN IF NOT EXISTS "steam_account_id" uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'match_streams_steam_account_id_fkey'
      AND table_name = 'match_streams'
  ) THEN
    ALTER TABLE "public"."match_streams"
      ADD CONSTRAINT "match_streams_steam_account_id_fkey"
      FOREIGN KEY ("steam_account_id")
      REFERENCES "public"."steam_accounts" ("id")
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "match_streams_steam_account_id_idx"
  ON "public"."match_streams" ("steam_account_id")
  WHERE "steam_account_id" IS NOT NULL;


ALTER TABLE "public"."match_demo_sessions"
  ADD COLUMN IF NOT EXISTS "steam_account_id" uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'match_demo_sessions_steam_account_id_fkey'
      AND table_name = 'match_demo_sessions'
  ) THEN
    ALTER TABLE "public"."match_demo_sessions"
      ADD CONSTRAINT "match_demo_sessions_steam_account_id_fkey"
      FOREIGN KEY ("steam_account_id")
      REFERENCES "public"."steam_accounts" ("id")
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "match_demo_sessions_steam_account_id_idx"
  ON "public"."match_demo_sessions" ("steam_account_id")
  WHERE "steam_account_id" IS NOT NULL;


ALTER TABLE "public"."clip_render_jobs"
  ADD COLUMN IF NOT EXISTS "steam_account_id" uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'clip_render_jobs_steam_account_id_fkey'
      AND table_name = 'clip_render_jobs'
  ) THEN
    ALTER TABLE "public"."clip_render_jobs"
      ADD CONSTRAINT "clip_render_jobs_steam_account_id_fkey"
      FOREIGN KEY ("steam_account_id")
      REFERENCES "public"."steam_accounts" ("id")
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "clip_render_jobs_steam_account_id_idx"
  ON "public"."clip_render_jobs" ("steam_account_id")
  WHERE "steam_account_id" IS NOT NULL;
