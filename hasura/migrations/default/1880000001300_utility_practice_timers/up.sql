-- Two different clocks, and conflating them is what made a practice server
-- impossible to reclaim: a session nobody ever joined is waiting on a connect,
-- while one that emptied out is idle. They deserve different grace.
ALTER TABLE "public"."utility_practice_sessions"
  ADD COLUMN IF NOT EXISTS "first_joined_at" timestamptz;

-- Who is waiting for a practice server. A row exists only between a start that
-- found nothing free and the start that finally succeeds, so an empty table
-- means nobody is queuing -- which is what lets an uncontended session run for
-- as long as its host wants.
CREATE TABLE IF NOT EXISTS "public"."utility_practice_waitlist" (
    "steam_id" bigint NOT NULL,
    "map_name" text,
    "region" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("steam_id"),
    CONSTRAINT "utility_practice_waitlist_player_fkey" FOREIGN KEY ("steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "utility_practice_waitlist_created_at_idx"
    ON "public"."utility_practice_waitlist" ("created_at");
