DROP INDEX IF EXISTS "public"."nade_lineups_forked_from_idx";

ALTER TABLE IF EXISTS "public"."nade_lineups"
    DROP CONSTRAINT IF EXISTS "nade_lineups_forked_from_fkey";

ALTER TABLE IF EXISTS "public"."nade_lineups"
    DROP COLUMN IF EXISTS "forked_from_nade_lineup_id";

ALTER TABLE IF EXISTS "public"."nade_lineups"
    ALTER COLUMN "confidence" SET DEFAULT 'exact';
