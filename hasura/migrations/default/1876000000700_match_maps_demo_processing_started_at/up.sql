ALTER TABLE "public"."match_maps"
  ADD COLUMN IF NOT EXISTS "demo_processing_started_at" timestamptz;
