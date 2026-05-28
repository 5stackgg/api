DROP INDEX IF EXISTS "steam_accounts_enabled_idx";

-- An earlier build defined this view with "where enabled = true", so a
-- prior boot left a stale view that depends on the column. Migrations run
-- before views are re-applied, so drop it here; apply(views) recreates it.
DROP VIEW IF EXISTS "public"."v_steam_account_pool_status";

ALTER TABLE "public"."steam_accounts"
  DROP COLUMN IF EXISTS "enabled";
