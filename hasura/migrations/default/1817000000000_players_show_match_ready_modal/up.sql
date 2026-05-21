ALTER TABLE "public"."players"
ADD COLUMN IF NOT EXISTS "show_match_ready_modal" boolean NOT NULL DEFAULT true;
