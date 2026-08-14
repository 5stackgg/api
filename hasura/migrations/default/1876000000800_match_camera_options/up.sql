ALTER TABLE "public"."match_options"
    ADD COLUMN IF NOT EXISTS "camera_required" boolean NOT NULL DEFAULT false;

-- Lets a player see their own side's cameras. Never the other side: that would
-- hand a competitor a live view of the opposition.
ALTER TABLE "public"."match_options"
    ADD COLUMN IF NOT EXISTS "camera_allow_teammates" boolean NOT NULL DEFAULT false;
