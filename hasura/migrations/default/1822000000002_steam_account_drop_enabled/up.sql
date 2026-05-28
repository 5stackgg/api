DROP INDEX IF EXISTS "steam_accounts_enabled_idx";

ALTER TABLE "public"."steam_accounts"
  DROP COLUMN IF EXISTS "enabled";
