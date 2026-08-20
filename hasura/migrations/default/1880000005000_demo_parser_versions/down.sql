DROP INDEX IF EXISTS "public"."match_map_demos_versions_idx";

ALTER TABLE "public"."match_map_demos"
    DROP COLUMN IF EXISTS "playback_version",
    DROP COLUMN IF EXISTS "parser_version";
