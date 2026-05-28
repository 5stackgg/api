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
