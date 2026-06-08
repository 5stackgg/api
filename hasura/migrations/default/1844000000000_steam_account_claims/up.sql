-- One ledger of steam-account claims keyed by k8s job name, replacing the
-- per-consumer-table steam_account_id columns.
CREATE TABLE IF NOT EXISTS "public"."steam_account_claims" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "steam_account_id" uuid NOT NULL,
  "node_id" text NULL,
  "k8s_job_name" text NOT NULL,
  "purpose" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  UNIQUE ("k8s_job_name"),
  FOREIGN KEY ("steam_account_id")
    REFERENCES "public"."steam_accounts" ("id")
    ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY ("node_id")
    REFERENCES "public"."game_server_nodes" ("id")
    ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "steam_account_claims_steam_account_id_idx"
  ON "public"."steam_account_claims" ("steam_account_id");

-- Repoint the busy set before dropping the columns it used to read.
CREATE OR REPLACE FUNCTION public.busy_steam_account_ids()
  RETURNS setof uuid
  LANGUAGE sql
  STABLE
AS $$
  SELECT steam_account_id FROM steam_account_claims
$$;

ALTER TABLE "public"."match_streams"
  DROP CONSTRAINT IF EXISTS "match_streams_steam_account_id_fkey";
DROP INDEX IF EXISTS "public"."match_streams_steam_account_id_idx";
ALTER TABLE "public"."match_streams"
  DROP COLUMN IF EXISTS "steam_account_id";

ALTER TABLE "public"."match_demo_sessions"
  DROP CONSTRAINT IF EXISTS "match_demo_sessions_steam_account_id_fkey";
DROP INDEX IF EXISTS "public"."match_demo_sessions_steam_account_id_idx";
ALTER TABLE "public"."match_demo_sessions"
  DROP COLUMN IF EXISTS "steam_account_id";

ALTER TABLE "public"."clip_render_jobs"
  DROP CONSTRAINT IF EXISTS "clip_render_jobs_steam_account_id_fkey";
DROP INDEX IF EXISTS "public"."clip_render_jobs_steam_account_id_idx";
ALTER TABLE "public"."clip_render_jobs"
  DROP COLUMN IF EXISTS "steam_account_id";
