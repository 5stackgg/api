-- Web push notifications, whole.
--
-- One row per browser/device push subscription. A single steam_id can have
-- several rows (phone + desktop), and every matching one gets sent to.
-- Uniqueness is on endpoint -- the browser's own push-service URL -- rather
-- than on steam_id, precisely to allow that multi-device fan-out.
--
-- The endpoint check keeps the invariant true for anything inserted outside the
-- application, and makes the intent visible in the schema rather than only in
-- TypeScript (see src/notifications/push/push-endpoint.ts). Without it the API
-- can be aimed at a host that is not a push service at all.
CREATE TABLE IF NOT EXISTS "public"."push_subscriptions" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "steam_id" bigint NOT NULL,
    "endpoint" text NOT NULL,
    "p256dh" text NOT NULL,
    "auth" text NOT NULL,
    "user_agent" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "last_used_at" timestamp with time zone,
    PRIMARY KEY ("id"),
    FOREIGN KEY ("steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade,
    UNIQUE ("endpoint"),
    CONSTRAINT "push_subscriptions_endpoint_is_push_service" CHECK (
        "endpoint" ~* '^https://([a-z0-9-]+\.)*(push\.apple\.com|notify\.windows\.com|push\.services\.mozilla\.com)(/|$)'
        OR "endpoint" ~* '^https://(fcm|android)\.googleapis\.com(/|$)'
    )
);

CREATE INDEX IF NOT EXISTS "push_subscriptions_steam_id_idx"
    ON "public"."push_subscriptions" ("steam_id");

-- Per-player notification opt-out, for both delivery channels at once.
--
-- Absence of a row means "use this key's own default", so no backfill is ever
-- needed and every existing and future player stays on whatever the default
-- is. Only explicit choices are stored.
--
-- `key` means different things per channel and that is deliberate: push groups
-- the ~34 notification types into a handful of coarse categories a player can
-- mute, while the in-app bell exposes a small hand-picked set of individual
-- types. See src/notifications/preferences/notification-categories.ts.
CREATE TABLE IF NOT EXISTS "public"."notification_preferences" (
    "steam_id" bigint NOT NULL,
    "channel" text NOT NULL,
    "key" text NOT NULL,
    "enabled" boolean NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY ("steam_id", "channel", "key"),
    FOREIGN KEY ("steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade,
    CONSTRAINT "notification_preferences_channel_check"
        CHECK ("channel" IN ('push', 'in_app'))
);

-- notifications had no index beyond its primary key. Three separate features
-- dedupe by (type, entity_id) via NOT EXISTS -- LeagueWeekReminders,
-- TournamentReminders, and the ChatMessage bell collapse -- and the bell reads
-- unread rows per player on every page load.
CREATE INDEX IF NOT EXISTS "notifications_type_entity_id_idx"
    ON "public"."notifications" ("type", "entity_id");

CREATE INDEX IF NOT EXISTS "notifications_unread_steam_id_idx"
    ON "public"."notifications" ("steam_id")
    WHERE "is_read" = false AND "deleted_at" IS NULL;

-- Quiet hours are stored as local wall-clock times plus the player's zone,
-- rather than as a UTC window, so the window keeps meaning "10pm to 7am" across
-- daylight-saving shifts and travel instead of drifting by an hour.
ALTER TABLE "public"."players"
  ADD COLUMN IF NOT EXISTS "quiet_hours_start" time,
  ADD COLUMN IF NOT EXISTS "quiet_hours_end" time,
  ADD COLUMN IF NOT EXISTS "notification_timezone" text;
