-- Notifications, whole: web push delivery, per-channel preferences, quiet
-- hours, and the indexes the bell reads through.
--
-- Every statement here is idempotent, and has to stay that way. This started
-- life as 1877000000000 plus two follow-ups; squashing them meant stacks that
-- had already applied the first would never see the rest, so the version was
-- bumped to re-run the lot over whatever they already have.
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

-- Push is delivered by the INSERT event trigger on `notifications`, so dropping
-- a recipient who muted the type in the bell would silence their push as well --
-- even though push carries its own, separate preference. Every recipient who
-- can receive one or the other gets a row, and this column is what keeps the
-- muted ones out of the bell. The select_permissions filter on it; nothing
-- reads it client side.
ALTER TABLE "public"."notifications"
    ADD COLUMN IF NOT EXISTS "in_app" boolean NOT NULL DEFAULT true;

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

-- One-off sweep of the alerts that accumulated before they were retracted on
-- resume/finish/cancel (see NotificationsService.resolveMatchAlerts).
--
-- "Map is paused" and "waiting for a server" describe a condition, so any of
-- them still outstanding against a match that has since stopped is describing
-- nothing. Live matches are deliberately left alone -- their alerts may still
-- be true.
UPDATE public.notifications n
   SET deleted_at = now()
  FROM public.matches m
 WHERE n.type = 'MatchStatusChange'
   AND n.deleted_at IS NULL
   AND m.id::text = n.entity_id
   AND m.status IN ('Canceled', 'Finished', 'Forfeit', 'Tie', 'Surrendered');

-- Alerts whose match no longer exists at all can never be resolved by an event,
-- so they would otherwise sit in the bell forever.
UPDATE public.notifications n
   SET deleted_at = now()
 WHERE n.type = 'MatchStatusChange'
   AND n.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.matches m WHERE m.id::text = n.entity_id
   );
