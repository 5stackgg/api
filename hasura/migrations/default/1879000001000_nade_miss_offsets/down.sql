ALTER TABLE IF EXISTS "public"."nade_lineup_progress"
    DROP COLUMN IF EXISTS "miss_vertical_sum",
    DROP COLUMN IF EXISTS "miss_lateral_sum",
    DROP COLUMN IF EXISTS "miss_along_sum",
    DROP COLUMN IF EXISTS "miss_samples";
