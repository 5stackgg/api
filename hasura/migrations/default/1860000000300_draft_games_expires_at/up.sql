ALTER TABLE "public"."draft_games" ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;
