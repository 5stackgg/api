-- Preview clips for the shared library.
--
-- A lineup that reaches the public library gets filmed once: the render pod
-- stands on the lineup, re-emits the recorded throw and uploads the clip. The
-- queue row below is the same shape as clip_render_jobs -- same status names,
-- same token/x-origin-auth handshake, same status_history -- because the pod
-- talks to both through the same three endpoints.

CREATE TABLE IF NOT EXISTS "public"."utility_lineup_renders" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "utility_lineup_id" uuid NOT NULL,

    -- Who asked. Null once that player is deleted; the render is still valid.
    "requested_by_steam_id" bigint,

    -- One server session films one map, so the map the batch was queued for is
    -- part of the queue row rather than something re-read off the lineup: a
    -- lineup that gets re-classified mid-flight must not silently move batches.
    "map_name" text NOT NULL,

    "session_token" text NOT NULL,
    "k8s_job_name" text,
    "game_server_node_id" text,
    "utility_practice_session_id" uuid,

    "spec" jsonb NOT NULL,

    "status" text NOT NULL DEFAULT 'queued',
    "progress" numeric(4, 3),
    "error_message" text,
    -- A lineup the pod refuses to film (no physics seed, wrong runtime, wrong
    -- map) is not a failure to retry -- it is a fact about the lineup, and the
    -- reviewer needs the sentence, not a stack trace.
    "skip_reason" text,

    "duration_ms" integer,
    "paused" boolean NOT NULL DEFAULT false,
    "sort_index" integer NOT NULL DEFAULT 0,
    "status_history" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "last_status_at" timestamptz NOT NULL DEFAULT now(),
    "created_at" timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY ("id"),

    CONSTRAINT "utility_lineup_renders_lineup_fkey" FOREIGN KEY ("utility_lineup_id")
        REFERENCES "public"."utility_lineups" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "utility_lineup_renders_requested_by_fkey" FOREIGN KEY ("requested_by_steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "utility_lineup_renders_node_fkey" FOREIGN KEY ("game_server_node_id")
        REFERENCES "public"."game_server_nodes" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "utility_lineup_renders_session_fkey" FOREIGN KEY ("utility_practice_session_id")
        REFERENCES "public"."utility_practice_sessions" ("id") ON UPDATE CASCADE ON DELETE SET NULL,

    CONSTRAINT "utility_lineup_renders_status_chk"
        CHECK ("status" IN ('queued', 'rendering', 'uploading', 'done', 'error', 'skipped', 'cancelled')),
    CONSTRAINT "utility_lineup_renders_progress_chk"
        CHECK ("progress" IS NULL OR ("progress" >= 0 AND "progress" <= 1))
);

-- Approving a lineup twice must not book a second GPU for the same clip, and a
-- reviewer mashing "re-render" must not either. Idempotency is a database fact
-- rather than a check-then-insert, because the event trigger retries.
CREATE UNIQUE INDEX IF NOT EXISTS "utility_lineup_renders_one_in_flight_idx"
    ON "public"."utility_lineup_renders" ("utility_lineup_id")
    WHERE "status" IN ('queued', 'rendering', 'uploading');

-- The batch dispatcher's only read: everything queued, grouped by map.
CREATE INDEX IF NOT EXISTS "utility_lineup_renders_queue_idx"
    ON "public"."utility_lineup_renders" ("map_name", "sort_index", "created_at")
    WHERE "status" IN ('queued', 'rendering', 'uploading');

CREATE INDEX IF NOT EXISTS "utility_lineup_renders_status_created_at_idx"
    ON "public"."utility_lineup_renders" ("status", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "utility_lineup_renders_lineup_idx"
    ON "public"."utility_lineup_renders" ("utility_lineup_id", "created_at" DESC);

-- The finished clip lands ON the lineup, not behind a join to the render row.
-- Three reasons, in order of weight:
--   1. the public library is read by guests, one row per card, 200 to a grid;
--      an FK would mean either widening select on a queue table full of k8s job
--      names and session tokens to `guest`, or a second query per card.
--   2. a lineup keeps its LAST GOOD preview. Renders are retried, and a failed
--      re-render pointing at the lineup would blank a page that was fine.
--   3. the render row is disposable -- it is a job, and old jobs get cleared.
ALTER TABLE "public"."utility_lineups"
    ADD COLUMN IF NOT EXISTS "preview_file" text,
    ADD COLUMN IF NOT EXISTS "preview_thumbnail" text,
    ADD COLUMN IF NOT EXISTS "preview_duration_ms" integer,
    ADD COLUMN IF NOT EXISTS "preview_rendered_at" timestamptz;

CREATE INDEX IF NOT EXISTS "utility_lineups_preview_idx"
    ON "public"."utility_lineups" ("map_name", "utility_type")
    WHERE "preview_file" IS NOT NULL AND "archived_at" IS NULL;

-- A render books a practice server the same way a player does, but nobody is
-- sitting on it: the connect grace and the idle clock both measure a human
-- walking away, and neither describes a pod that is still installing cs2. The
-- batch job owns a render session's lifetime instead.
ALTER TABLE "public"."utility_practice_sessions"
    ADD COLUMN IF NOT EXISTS "is_render" boolean NOT NULL DEFAULT false;

DROP INDEX IF EXISTS "public"."utility_practice_sessions_one_live_per_host_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "utility_practice_sessions_one_live_per_host_idx"
    ON "public"."utility_practice_sessions" ("host_steam_id")
    WHERE "status" IN ('Starting', 'Ready') AND "is_render" = false;

CREATE INDEX IF NOT EXISTS "utility_practice_sessions_render_idx"
    ON "public"."utility_practice_sessions" ("status", "created_at")
    WHERE "is_render" = true;
