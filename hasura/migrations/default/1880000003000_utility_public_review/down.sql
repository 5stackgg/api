DROP INDEX IF EXISTS "public"."utility_lineups_public_queue_idx";

ALTER TABLE "public"."utility_lineups"
    DROP CONSTRAINT IF EXISTS "utility_lineups_public_reviewed_by_fkey";

ALTER TABLE "public"."utility_lineups"
    DROP COLUMN IF EXISTS "public_review_note",
    DROP COLUMN IF EXISTS "public_reviewed_by",
    DROP COLUMN IF EXISTS "public_reviewed_at",
    DROP COLUMN IF EXISTS "public_requested_at";
