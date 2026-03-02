-- Add MatchStatusChange to notification types
INSERT INTO e_notification_types ("value", "description") VALUES
    ('MatchStatusChange', 'Match Status Change Notification')
ON CONFLICT("value") DO UPDATE SET "description" = EXCLUDED."description";

-- Add per-tournament Discord override column
ALTER TABLE "public"."tournaments"
ADD COLUMN IF NOT EXISTS "discord_notifications_enabled" boolean DEFAULT NULL;
