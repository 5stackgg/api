ALTER TABLE "public"."players"
  DROP COLUMN IF EXISTS "notification_timezone",
  DROP COLUMN IF EXISTS "quiet_hours_end",
  DROP COLUMN IF EXISTS "quiet_hours_start";

DROP INDEX IF EXISTS "public"."notifications_unread_steam_id_idx";
DROP INDEX IF EXISTS "public"."notifications_type_entity_id_idx";

DROP TABLE IF EXISTS "public"."notification_preferences";
DROP TABLE IF EXISTS "public"."push_subscriptions";
