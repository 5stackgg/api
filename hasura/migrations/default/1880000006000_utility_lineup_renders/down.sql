DROP INDEX IF EXISTS "public"."utility_practice_sessions_render_idx";
DROP INDEX IF EXISTS "public"."utility_practice_sessions_one_live_per_host_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "utility_practice_sessions_one_live_per_host_idx"
    ON "public"."utility_practice_sessions" ("host_steam_id")
    WHERE "status" IN ('Starting', 'Ready');

ALTER TABLE "public"."utility_practice_sessions"
    DROP COLUMN IF EXISTS "is_render";

DROP INDEX IF EXISTS "public"."utility_lineups_preview_idx";

ALTER TABLE "public"."utility_lineups"
    DROP COLUMN IF EXISTS "preview_rendered_at",
    DROP COLUMN IF EXISTS "preview_duration_ms",
    DROP COLUMN IF EXISTS "preview_thumbnail",
    DROP COLUMN IF EXISTS "preview_file";

DROP TABLE IF EXISTS "public"."utility_lineup_renders";
