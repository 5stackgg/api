ALTER TABLE "public"."players"
  DROP COLUMN IF EXISTS "quiet_hours_start",
  DROP COLUMN IF EXISTS "quiet_hours_end",
  DROP COLUMN IF EXISTS "notification_timezone";
