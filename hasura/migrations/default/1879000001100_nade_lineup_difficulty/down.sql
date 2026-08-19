DROP FUNCTION IF EXISTS "public"."nade_lineup_difficulty"("public"."nade_lineups");

ALTER TABLE IF EXISTS "public"."nade_lineups"
    DROP COLUMN IF EXISTS "practice_successes",
    DROP COLUMN IF EXISTS "practice_attempts",
    DROP COLUMN IF EXISTS "practice_players";
