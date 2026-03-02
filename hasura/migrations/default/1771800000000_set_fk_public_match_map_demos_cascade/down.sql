ALTER TABLE "public"."match_map_demos"
  DROP CONSTRAINT "match_demos_match_id_fkey",
  ADD CONSTRAINT "match_demos_match_id_fkey"
  FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id")
  ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "public"."match_map_demos"
  DROP CONSTRAINT "match_demos_match_map_id_fkey",
  ADD CONSTRAINT "match_demos_match_map_id_fkey"
  FOREIGN KEY ("match_map_id") REFERENCES "public"."match_maps"("id")
  ON UPDATE CASCADE ON DELETE RESTRICT;
