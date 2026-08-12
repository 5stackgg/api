-- abandoned_matches only recorded steam_id/abandoned_at, so nothing tied a
-- record to the match it came from and the profile's Abandoned tab had no real
-- match to link to. Nullable: historical rows have no match to backfill from,
-- and the record must outlive the match being deleted.
ALTER TABLE "public"."abandoned_matches"
  ADD COLUMN IF NOT EXISTS "match_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'abandoned_matches_match_id_fkey'
  ) THEN
    ALTER TABLE "public"."abandoned_matches"
      ADD CONSTRAINT "abandoned_matches_match_id_fkey"
      FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id")
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;
