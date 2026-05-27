-- Idempotent follow-up for steam_account_pool. Earlier boots may have
-- applied the 1822000000000 migration before the FK columns and the
-- last_node_id pinning column were added — or never applied it at all
-- and lost track of state. This re-creates anything missing.

CREATE TABLE IF NOT EXISTS "public"."steam_accounts" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "username" text NOT NULL,
  "password" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  UNIQUE ("username")
);

CREATE INDEX IF NOT EXISTS "steam_accounts_enabled_idx"
  ON "public"."steam_accounts" ("enabled")
  WHERE "enabled" = true;

ALTER TABLE "public"."steam_accounts"
  ADD COLUMN IF NOT EXISTS "last_node_id" text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'steam_accounts_last_node_id_fkey'
      AND table_name = 'steam_accounts'
  ) THEN
    ALTER TABLE "public"."steam_accounts"
      ADD CONSTRAINT "steam_accounts_last_node_id_fkey"
      FOREIGN KEY ("last_node_id")
      REFERENCES "public"."game_server_nodes" ("id")
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;

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
