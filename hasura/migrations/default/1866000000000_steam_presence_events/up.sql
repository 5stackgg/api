-- Real-time activity feed for the presence bot admin dashboard, subscribed to
-- over websockets via Hasura (replaces the Redis ring buffer).
CREATE TABLE IF NOT EXISTS "public"."steam_presence_events" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "type" text NOT NULL,
  "message" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS idx_steam_presence_events_created_at
  ON public.steam_presence_events (created_at DESC);

-- Bot's Steam level — friend capacity is derived from it (Steam allows
-- 250 + 5*level friends, capped at 2000). Detected on login.
ALTER TABLE "public"."steam_accounts"
  ADD COLUMN IF NOT EXISTS "steam_level" integer;
