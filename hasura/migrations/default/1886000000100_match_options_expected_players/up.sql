-- The total a match actually launched with, across both lineups.
--
-- Its own migration rather than an edit to 1886000000000, because migrations are
-- tracked by version and never re-read: appending to one that has already been
-- applied is a silent no-op on every database that ran it.
--
-- Separate from min_players_per_lineup because a single per-lineup number cannot
-- express an uneven start. A 1v2 records 1 there -- the gates apply that to
-- *both* sides, so the smaller one has to clear -- while the game server still
-- has to wait for 3 people. Counts starters only; NULL on every match that did
-- not start short-handed.
ALTER TABLE "public"."match_options"
    ADD COLUMN IF NOT EXISTS "expected_players" integer;
