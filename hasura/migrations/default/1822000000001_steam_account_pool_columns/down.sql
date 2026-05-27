ALTER TABLE "public"."clip_render_jobs"
  DROP CONSTRAINT IF EXISTS "clip_render_jobs_steam_account_id_fkey";
DROP INDEX IF EXISTS "clip_render_jobs_steam_account_id_idx";
ALTER TABLE "public"."clip_render_jobs"
  DROP COLUMN IF EXISTS "steam_account_id";

ALTER TABLE "public"."match_demo_sessions"
  DROP CONSTRAINT IF EXISTS "match_demo_sessions_steam_account_id_fkey";
DROP INDEX IF EXISTS "match_demo_sessions_steam_account_id_idx";
ALTER TABLE "public"."match_demo_sessions"
  DROP COLUMN IF EXISTS "steam_account_id";

ALTER TABLE "public"."match_streams"
  DROP CONSTRAINT IF EXISTS "match_streams_steam_account_id_fkey";
DROP INDEX IF EXISTS "match_streams_steam_account_id_idx";
ALTER TABLE "public"."match_streams"
  DROP COLUMN IF EXISTS "steam_account_id";

ALTER TABLE "public"."steam_accounts"
  DROP CONSTRAINT IF EXISTS "steam_accounts_last_node_id_fkey";
DROP INDEX IF EXISTS "steam_accounts_last_node_id_idx";
ALTER TABLE "public"."steam_accounts"
  DROP COLUMN IF EXISTS "last_node_id";

DROP INDEX IF EXISTS "steam_accounts_enabled_idx";
DROP TABLE IF EXISTS "public"."steam_accounts";
