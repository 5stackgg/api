-- A seeded map pool is one row every option set shares, so a stage that chose
-- its tournament's pool holds the same id as one that inherited it. Set, the
-- row keeps its pool when the pool it was copied from changes.
ALTER TABLE public.match_options
    ADD COLUMN IF NOT EXISTS map_pool_explicit boolean NOT NULL DEFAULT false;
