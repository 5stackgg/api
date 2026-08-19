-- Consecutive successes are kept as a running counter rather than derived,
-- because deriving one means keeping every throw: a practice server produces a
-- result every few seconds per player, and none of those rows is worth storing
-- once it has moved the counter. The whole scoring write path is one upsert,
-- and a streak that is a column stays inside it.
ALTER TABLE "public"."nade_lineup_progress"
    ADD COLUMN IF NOT EXISTS "current_streak" integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "best_streak" integer NOT NULL DEFAULT 0;
