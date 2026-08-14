ALTER TABLE "public"."match_options"
    DROP COLUMN IF EXISTS "camera_allow_teammates";

ALTER TABLE "public"."match_options"
    DROP COLUMN IF EXISTS "camera_required";
