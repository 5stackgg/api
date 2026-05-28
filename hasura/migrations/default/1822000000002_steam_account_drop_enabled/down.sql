ALTER TABLE "public"."steam_accounts"
  ADD COLUMN IF NOT EXISTS "enabled" boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS "steam_accounts_enabled_idx"
  ON "public"."steam_accounts" ("enabled")
  WHERE "enabled" = true;
