-- The engine's own starting state for the projectile (m_vInitialPosition /
-- m_vInitialVelocity). Storing it is what lets a throw be re-emitted and
-- reproduced bit for bit later -- a ghost replay, an oracle solver's winning
-- candidate, or a re-simulation against a patched collision mesh.
--
-- Nullable on purpose, and never defaulted: a demo-mined, hand-placed or
-- imported lineup genuinely has no seed, and NULL has to keep meaning "cannot
-- be replayed exactly". A zeroed seed is not a missing one -- it is a grenade
-- launched from the world origin.
ALTER TABLE "public"."nade_lineups"
    ADD COLUMN IF NOT EXISTS "initial_pos_x" double precision,
    ADD COLUMN IF NOT EXISTS "initial_pos_y" double precision,
    ADD COLUMN IF NOT EXISTS "initial_pos_z" double precision,
    ADD COLUMN IF NOT EXISTS "initial_vel_x" double precision,
    ADD COLUMN IF NOT EXISTS "initial_vel_y" double precision,
    ADD COLUMN IF NOT EXISTS "initial_vel_z" double precision;
