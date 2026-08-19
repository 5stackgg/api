ALTER TABLE IF EXISTS "public"."nade_lineup_progress"
    DROP COLUMN IF EXISTS "best_streak",
    DROP COLUMN IF EXISTS "current_streak";
