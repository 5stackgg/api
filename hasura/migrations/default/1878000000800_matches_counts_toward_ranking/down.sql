DROP INDEX IF EXISTS "public"."matches_counts_toward_ranking_idx";

ALTER TABLE "public"."matches"
    DROP COLUMN IF EXISTS "counts_toward_ranking";
