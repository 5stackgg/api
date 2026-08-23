DROP FUNCTION IF EXISTS "public"."utility_lineup_difficulty"("public"."utility_lineups");

ALTER TABLE IF EXISTS "public"."utility_lineups"
    DROP COLUMN IF EXISTS "practice_successes",
    DROP COLUMN IF EXISTS "practice_attempts",
    DROP COLUMN IF EXISTS "practice_players";

ALTER TABLE IF EXISTS "public"."utility_lineup_progress"
    DROP COLUMN IF EXISTS "miss_vertical_sum",
    DROP COLUMN IF EXISTS "miss_lateral_sum",
    DROP COLUMN IF EXISTS "miss_along_sum",
    DROP COLUMN IF EXISTS "miss_samples";

DROP TABLE IF EXISTS "public"."utility_lineup_repairs";

DROP INDEX IF EXISTS "public"."utility_lineups_forked_from_idx";

ALTER TABLE IF EXISTS "public"."utility_lineups"
    DROP CONSTRAINT IF EXISTS "utility_lineups_forked_from_fkey";

ALTER TABLE IF EXISTS "public"."utility_lineups"
    DROP COLUMN IF EXISTS "forked_from_utility_lineup_id";

ALTER TABLE IF EXISTS "public"."utility_lineups"
    ALTER COLUMN "confidence" SET DEFAULT 'exact';

DROP TABLE IF EXISTS "public"."utility_drift_results";
DROP TABLE IF EXISTS "public"."utility_drift_scans";

DROP TABLE IF EXISTS "public"."utility_meta_lineups";
DROP TABLE IF EXISTS "public"."utility_demo_mines";
DROP TABLE IF EXISTS "public"."utility_demo_throws";

ALTER TABLE "public"."utility_lineups"
    DROP COLUMN IF EXISTS "view_yaw_delta",
    DROP COLUMN IF EXISTS "view_pitch_delta";

ALTER TABLE IF EXISTS "public"."utility_lineups"
    DROP COLUMN IF EXISTS "initial_vel_z",
    DROP COLUMN IF EXISTS "initial_vel_y",
    DROP COLUMN IF EXISTS "initial_vel_x",
    DROP COLUMN IF EXISTS "initial_pos_z",
    DROP COLUMN IF EXISTS "initial_pos_y",
    DROP COLUMN IF EXISTS "initial_pos_x";

ALTER TABLE IF EXISTS "public"."utility_lineup_progress"
    DROP COLUMN IF EXISTS "best_streak",
    DROP COLUMN IF EXISTS "current_streak";

ALTER TABLE IF EXISTS "public"."utility_practice_sessions"
    DROP COLUMN IF EXISTS "playbook_id";

DROP TABLE IF EXISTS "public"."utility_playbook_steps";
DROP TABLE IF EXISTS "public"."utility_playbooks";

DROP TABLE IF EXISTS "public"."utility_practice_invites";
DROP TABLE IF EXISTS "public"."utility_practice_sessions";
DROP TABLE IF EXISTS "public"."e_utility_practice_statuses";

DROP TABLE IF EXISTS "public"."utility_lineup_progress";
DROP TABLE IF EXISTS "public"."utility_lineup_favorites";
DROP TABLE IF EXISTS "public"."utility_lineup_votes";
DROP TABLE IF EXISTS "public"."utility_collection_items";
DROP TABLE IF EXISTS "public"."utility_collections";
DROP TABLE IF EXISTS "public"."utility_lineups";
DROP TABLE IF EXISTS "public"."e_utility_sources";
DROP TABLE IF EXISTS "public"."e_utility_throw_strengths";
DROP TABLE IF EXISTS "public"."e_utility_techniques";
DROP TABLE IF EXISTS "public"."e_utility_visibility";
