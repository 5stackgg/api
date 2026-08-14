-- name_registered was added nullable with no default, so most rows are NULL.
-- Anything checking it has to spell out `IS NULL OR = false`, and a plain
-- `= false` silently matches nothing -- see the on_conflict guards in
-- src/matches/events/PlayerConnected.ts and friends.
UPDATE "public"."players" SET "name_registered" = false WHERE "name_registered" IS NULL;

ALTER TABLE "public"."players" ALTER COLUMN "name_registered" SET DEFAULT false;
ALTER TABLE "public"."players" ALTER COLUMN "name_registered" SET NOT NULL;
