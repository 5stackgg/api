-- Publishing to the shared library becomes a review, not a self-service flag.
--
-- Until now any author could set visibility = 'Public' on their own lineup, so
-- the public library was whatever anyone chose to put in it. An author now asks
-- and a moderator answers; the gate itself is a trigger rather than a
-- permission, because a Hasura check only sees the resulting row and would
-- therefore also block an author from editing a lineup that is ALREADY public.

ALTER TABLE "public"."utility_lineups"
    ADD COLUMN IF NOT EXISTS "public_requested_at" timestamptz,
    ADD COLUMN IF NOT EXISTS "public_reviewed_at" timestamptz,
    ADD COLUMN IF NOT EXISTS "public_reviewed_by" bigint,
    ADD COLUMN IF NOT EXISTS "public_review_note" text;

DO $$
BEGIN
    ALTER TABLE "public"."utility_lineups"
        ADD CONSTRAINT "utility_lineups_public_reviewed_by_fkey"
        FOREIGN KEY ("public_reviewed_by")
        REFERENCES "public"."players" ("steam_id")
        ON UPDATE CASCADE ON DELETE SET NULL;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

-- The review queue is "asked, not yet public", which is the only shape the
-- moderator screen ever reads.
CREATE INDEX IF NOT EXISTS "utility_lineups_public_queue_idx"
    ON "public"."utility_lineups" ("public_requested_at")
    WHERE "public_requested_at" IS NOT NULL AND "visibility" <> 'Public';
