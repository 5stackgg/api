-- A demo-mined lineup has two independent readings of where the thrower was
-- looking: the aim recovered from the grenade's own flight, and the view angles
-- the demo recorded for the player at that tick. They should agree to a degree
-- or two. When they do not, one of them is wrong and there is no way to tell
-- which from inside the demo -- so both readings' disagreement is stored rather
-- than silently resolved in favour of either.
--
-- Degrees, signed, shortest arc. NULL means there was nothing to compare
-- against: no position sample close enough to the release, or a lineup that was
-- never mined from a demo at all.
ALTER TABLE "public"."nade_lineups"
    ADD COLUMN IF NOT EXISTS "view_yaw_delta" double precision,
    ADD COLUMN IF NOT EXISTS "view_pitch_delta" double precision;
