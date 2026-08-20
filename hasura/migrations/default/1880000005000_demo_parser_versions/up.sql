-- Which parser and which blob shape produced what is on this demo.
--
-- Both numbers already existed: the blob's own version is encoded in the
-- playback filename and the parser's is a field INSIDE the gzipped blob. Neither
-- is queryable, so "show me every demo that predates the grenade-throw position
-- burst" meant inflating every blob on the install to find out.
--
-- The burst is the case that forced this. Positions are ~4Hz except for a
-- full-rate window around each grenade throw, and that window only exists from
-- parser schema 2 -- so a lineup mined from an older demo is reading a sample up
-- to 125ms stale, and nothing on the row said so.
ALTER TABLE "public"."match_map_demos"
    ADD COLUMN IF NOT EXISTS "parser_version" integer,
    ADD COLUMN IF NOT EXISTS "playback_version" integer;

-- The blob version is recoverable for every demo already on disk: it is in the
-- filename. The parser version is not -- it only exists inside the blob -- so it
-- stays null until the demo is parsed again, and null therefore reads as
-- "older than we started recording this".
UPDATE "public"."match_map_demos"
   SET "playback_version" = NULLIF(
         substring("playback_file" from '/playback\.v([0-9]+)\.'),
         ''
       )::int
 WHERE "playback_file" IS NOT NULL
   AND "playback_version" IS NULL;

-- The reparse queue reads exactly this: anything below the current versions.
CREATE INDEX IF NOT EXISTS "match_map_demos_versions_idx"
    ON "public"."match_map_demos" ("playback_version", "parser_version")
    WHERE "playback_file" IS NOT NULL;
