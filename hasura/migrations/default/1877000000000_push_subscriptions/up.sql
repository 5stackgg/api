-- One row per browser/device push subscription. A single steam_id can have
-- several rows (phone + desktop), and every matching one gets sent to.
-- Uniqueness is on endpoint -- the browser's own push-service URL -- rather
-- than on steam_id, precisely to allow that multi-device fan-out.
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
    UNIQUE ("endpoint")
);

CREATE INDEX IF NOT EXISTS "push_subscriptions_steam_id_idx"
    ON "public"."push_subscriptions" ("steam_id");
