-- Remove per-tournament Discord override column
ALTER TABLE "public"."tournaments"
DROP COLUMN IF EXISTS "discord_notifications_enabled";

-- Remove MatchStatusChange from notification types
DELETE FROM e_notification_types WHERE "value" = 'MatchStatusChange';
