ALTER TABLE "public"."abandoned_matches"
  DROP CONSTRAINT IF EXISTS "abandoned_matches_match_id_fkey";
ALTER TABLE "public"."abandoned_matches"
  DROP COLUMN IF EXISTS "match_id";
