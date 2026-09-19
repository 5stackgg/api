-- The bell subscription reads the inbox sequentially, once per second, per
-- connected client.
--
-- It asks for "unread, or read but newer than X", and Hasura sends both
-- is_read values as query parameters rather than literals:
--
--     WHERE steam_id = $1 AND in_app AND deleted_at IS NULL
--       AND (is_read = $2 OR (is_read = $3 AND created_at > $4))
--
-- notifications_unread_steam_id_idx is partial on `is_read = false`, and the
-- planner cannot prove that predicate holds when is_read is a parameter inside
-- an OR. So it is unusable here and every evaluation falls back to a full
-- table scan. On a 28k-row table that is 1,776 buffers to return ~34 rows, and
-- the table had accumulated 3.7 million sequential scans reading 56 billion
-- tuples.
--
-- This index is keyed only on columns the query constrains with literals, so
-- the parameterised is_read clause becomes a cheap filter on a handful of
-- already-located rows instead of the thing driving the scan. created_at is in
-- the key to serve the ORDER BY, which the subscription always applies.
--
-- Deliberately not replacing notifications_unread_steam_id_idx: the unread
-- badge count does constrain is_read as a literal and is better served by the
-- narrower partial index.
CREATE INDEX IF NOT EXISTS "notifications_inbox_idx"
    ON "public"."notifications" ("steam_id", "created_at" DESC)
    WHERE "deleted_at" IS NULL AND "in_app";
