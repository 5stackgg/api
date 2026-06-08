-- Restore the per-table steam_account_id columns.
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

-- Restore the union-of-tables busy set.
CREATE OR REPLACE FUNCTION public.busy_steam_account_ids()
  RETURNS setof uuid
  LANGUAGE sql
  STABLE
AS $$
  select steam_account_id
    from match_streams
   where is_game_streamer = true
     and status is distinct from 'errored'
     and steam_account_id is not null
  union
  select steam_account_id
    from match_demo_sessions
   where status is distinct from 'errored'
     and steam_account_id is not null
  union
  select steam_account_id
    from clip_render_jobs
   where status in ('queued', 'rendering', 'uploading')
     and steam_account_id is not null
$$;

DROP TABLE IF EXISTS "public"."steam_account_claims";
