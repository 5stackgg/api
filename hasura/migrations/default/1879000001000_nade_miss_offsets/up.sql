-- Every practice throw already reports where the grenade landed and the
-- scoring path already reduces it to a distance. The direction was thrown
-- away, and the direction is the only half of it that can be coached: "most
-- people land this one short" is advice, "most people land this one 74 units
-- away" is not.
--
-- Running sums rather than a row per throw. A practice server produces a
-- result every few seconds per player, so per-throw rows are an unbounded
-- table that would need a retention policy and a reaper to stay one; four
-- columns join the upsert the scoring path already writes and cost it no
-- extra statement.
--
-- Per PLAYER rather than per lineup, and that is the whole reason they live
-- on this table: the pattern is read as a mean of player means, so somebody
-- who drills one lineup two hundred times contributes exactly one opinion --
-- the same as somebody who threw it ten times. Summed on the lineup, one
-- obsessive would BE the pattern everybody else is shown.
--
-- Not exposed to any insert or update permission, for the same reason the
-- streak columns are not: these are the API's measurement of a throw, and a
-- role that could write them could write itself a coaching pattern.
ALTER TABLE "public"."nade_lineup_progress"
    ADD COLUMN IF NOT EXISTS "miss_samples" integer NOT NULL DEFAULT 0,
    -- Source units along the throw's own axes, signed:
    -- +along = long, +lateral = right of the throw, +vertical = high.
    ADD COLUMN IF NOT EXISTS "miss_along_sum" double precision NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "miss_lateral_sum" double precision NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "miss_vertical_sum" double precision NOT NULL DEFAULT 0;
