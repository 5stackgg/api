-- Whether this match moves ELO and appears on stats leaderboards.
--
-- Stored on the match rather than derived from its game mode at ELO time, so
-- the decision is frozen the moment the match is created. Deriving it would
-- mean flipping a mode's competitive_safe flag silently rewrote whether matches
-- played months ago had counted.
--
-- Defaults true, so every match that already exists keeps counting.
ALTER TABLE "public"."matches"
    ADD COLUMN IF NOT EXISTS "counts_toward_ranking" boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS "matches_counts_toward_ranking_idx"
    ON "public"."matches" ("counts_toward_ranking")
    WHERE "counts_toward_ranking" = false;
