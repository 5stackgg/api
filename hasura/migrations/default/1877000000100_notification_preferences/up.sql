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
