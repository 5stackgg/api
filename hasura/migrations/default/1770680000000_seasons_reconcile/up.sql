-- Durable "this season's ELO/stats are stale and must be rebuilt" flag. Set by a
-- trigger whenever a season's boundaries change (or on insert covering past
-- matches) and cleared by the season backfill when it finishes. A sweeper job
-- re-enqueues any season left with needs_rebuild = true, so a missed Hasura event
-- can never permanently leave a season un-rebuilt.
ALTER TABLE public.seasons
    ADD COLUMN needs_rebuild BOOLEAN NOT NULL DEFAULT false;
