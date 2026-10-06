ALTER TABLE "public"."notifications" ADD COLUMN IF NOT EXISTS "deletable" boolean NOT NULL DEFAULT true;
