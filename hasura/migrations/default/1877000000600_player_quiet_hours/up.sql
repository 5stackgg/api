-- Quiet hours are stored as local wall-clock times plus the player's zone,
-- rather than as a UTC window, so the window keeps meaning "10pm to 7am" across
-- daylight-saving shifts and travel instead of drifting by an hour.
ALTER TABLE "public"."players"
  ADD COLUMN IF NOT EXISTS "quiet_hours_start" time,
  ADD COLUMN IF NOT EXISTS "quiet_hours_end" time,
  ADD COLUMN IF NOT EXISTS "notification_timezone" text;
