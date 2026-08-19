ALTER TABLE IF EXISTS "public"."nade_lineups"
    DROP COLUMN IF EXISTS "initial_vel_z",
    DROP COLUMN IF EXISTS "initial_vel_y",
    DROP COLUMN IF EXISTS "initial_vel_x",
    DROP COLUMN IF EXISTS "initial_pos_z",
    DROP COLUMN IF EXISTS "initial_pos_y",
    DROP COLUMN IF EXISTS "initial_pos_x";
