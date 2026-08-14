-- The stale-alert sweep at the end of up.sql is one-way: it cannot distinguish
-- rows it retracted from rows retracted by the application, and un-deleting
-- both would resurrect the backlog. Everything else reverses.
ALTER TABLE "public"."players"
  DROP COLUMN IF EXISTS "notification_timezone",
  DROP COLUMN IF EXISTS "quiet_hours_end",
  DROP COLUMN IF EXISTS "quiet_hours_start";

DROP INDEX IF EXISTS "public"."notifications_unread_steam_id_idx";
DROP INDEX IF EXISTS "public"."notifications_type_entity_id_idx";

ALTER TABLE "public"."notifications" DROP COLUMN IF EXISTS "in_app";

DROP TABLE IF EXISTS "public"."notification_preferences";
DROP TABLE IF EXISTS "public"."push_subscriptions";
