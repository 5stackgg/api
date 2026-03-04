ALTER TABLE "public"."tournament_brackets" ADD COLUMN IF NOT EXISTS "scheduled_at" timestamptz NULL;
